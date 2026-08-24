// 本地 OpenAI 兼容代理服务器。
// 支持：非流式转发 + 真流式透传（chunked / SSE 跨块缓冲 / 客户端断连续读 / 空闲超时）。
// R5 hook：log 回调即"可选终端"预留点。
import * as http from "http";
import * as https from "https";
import { appendBalance, appendRecord, UsageRecord } from "../jsonl";
import { SseUsageExtractor } from "./sse";
import { fmtRow } from "./termfmt";

const DEFAULT_API_URL = "https://api.deepseek.com/chat/completions";
const STREAM_IDLE_TIMEOUT_MS = 600 * 1000; // 流式等下一个字节的最大空闲时间
const BALANCE_URL =
  process.env.DEEPSEEK_BALANCE_URL ?? "https://api.deepseek.com/user/balance";
const BALANCE_THROTTLE_MS = 60 * 1000; // 余额查询节流：一分钟最多一次（402 时强制立即查）
let lastBalanceAt = 0;

export interface ProxyServerOptions {
  port: number;
  jsonlPath: string;
  balancePath?: string;
  apiUrl?: string;
  log?: (line: string) => void;
}

export function startProxyServer(
  opts: ProxyServerOptions,
): Promise<http.Server> {
  const { port, jsonlPath, balancePath, log = console.log } = opts;
  const apiUrl = opts.apiUrl ?? process.env.DEEPSEEK_API_URL ?? DEFAULT_API_URL;
  const server = http.createServer((req, res) => {
    void handle(req, res, apiUrl, jsonlPath, balancePath, log);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function usageFields(u: any) {
  u = u ?? {};
  return {
    pt: u.prompt_tokens ?? null,
    ct: u.completion_tokens ?? null,
    tt: u.total_tokens ?? null,
    ch: u.prompt_cache_hit_tokens ?? null,
    cm: u.prompt_cache_miss_tokens ?? null,
  };
}

function recordAndLog(
  jsonlPath: string,
  log: (s: string) => void,
  model: string,
  u: any,
  stream: boolean,
  status: number,
  error?: string,
): void {
  const f = usageFields(u);
  const rec: UsageRecord = {
    ts: new Date().toISOString(),
    model,
    prompt_tokens: f.pt,
    completion_tokens: f.ct,
    total_tokens: f.tt,
    cache_hit_tokens: f.ch,
    cache_miss_tokens: f.cm,
    stream,
    status,
    error,
  };
  appendRecord(jsonlPath, rec);
  log(
    fmtRow({
      model,
      pt: f.pt,
      ct: f.ct,
      tt: f.tt,
      ch: f.ch,
      cm: f.cm,
      stream,
      status,
      error,
    }),
  );
}

// 顺带查账户余额（方案 A）：用本次请求在手的 key，不落盘 key。
function queryBalance(
  auth: string,
  balancePath: string,
  log: (s: string) => void,
): void {
  const client = BALANCE_URL.startsWith("https:") ? https : http;
  let req: http.ClientRequest;
  try {
    req = client.get(BALANCE_URL, { headers: { Authorization: auth } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let totalCny: number | null = null;
        let isAvailable = false;
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          isAvailable = j.is_available === true;
          const infos: any[] = Array.isArray(j.balance_infos)
            ? j.balance_infos
            : [];
          const cny = infos.find(
            (i) => String(i?.currency ?? "").toUpperCase() === "CNY",
          );
          const pick = cny ?? infos[0];
          if (pick && typeof pick.total_balance === "string") {
            const n = Number(pick.total_balance);
            if (Number.isFinite(n)) totalCny = n;
          }
        } catch {
          // 解析失败忽略
        }
        appendBalance(balancePath, {
          ts: new Date().toISOString(),
          totalCny,
          isAvailable,
        });
        log(
          `[balance] ${totalCny === null ? "n/a" : "￥" + totalCny}${
            isAvailable ? "" : " (unavailable)"
          }`,
        );
      });
    });
  } catch {
    return;
  }
  req.on("error", () => {
    /* 忽略：余额查询失败不阻断转发 */
  });
  req.setTimeout(5000, () => req.destroy());
}

function maybeQueryBalance(
  auth: string,
  balancePath: string | undefined,
  force: boolean,
  log: (s: string) => void,
): void {
  if (!balancePath || !auth) return;
  const now = Date.now();
  if (!force && now - lastBalanceAt < BALANCE_THROTTLE_MS) return;
  lastBalanceAt = now;
  queryBalance(auth, balancePath, log);
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  apiUrl: string,
  jsonlPath: string,
  balancePath: string | undefined,
  log: (s: string) => void,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    res.end();
    return;
  }
  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (path !== "/v1/chat/completions" && path !== "/chat/completions") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const body = await readBody(req);
  let payload: any;
  try {
    payload = JSON.parse(body || "{}");
  } catch (e: any) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e) }));
    return;
  }
  const model = payload.model ?? "deepseek-v4-flash";

  if (payload.stream) {
    await handleStream(req, res, apiUrl, jsonlPath, balancePath, log, model, payload);
    return;
  }

  const auth = req.headers.authorization ?? "";
  try {
    const up = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const raw = Buffer.from(await up.arrayBuffer());
    let u: any = null;
    try {
      u = JSON.parse(raw.toString("utf8")).usage ?? null;
    } catch {
      // 无 usage
    }
    recordAndLog(jsonlPath, log, model, u, false, up.status);
    maybeQueryBalance(auth, balancePath, up.status === 402, log);
    res.writeHead(up.status, {
      "Content-Type": up.headers.get("content-type") ?? "application/json",
    });
    res.end(raw);
  } catch (e: any) {
    recordAndLog(jsonlPath, log, model, null, false, 0, String(e));
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  }
}

// 真流式透传：边收上游 chunk 边转发给客户端，末尾抓 usage 落库。
// #1 客户端断开：停止转发，但继续读完上游以抓 usage（被中断的生成照样计费）。
function handleStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  apiUrl: string,
  jsonlPath: string,
  balancePath: string | undefined,
  log: (s: string) => void,
  model: string,
  payload: any,
): Promise<void> {
  return new Promise((resolve) => {
    const auth = req.headers.authorization ?? "";
    const body = JSON.stringify({
      ...payload,
      stream_options: { include_usage: true, ...(payload.stream_options ?? {}) },
    });

    // 按协议选 http/https 客户端：apiUrl 默认是 https 的 DeepSeek 端点
    const client = apiUrl.startsWith("https:") ? https : http;
    let upstream: http.ClientRequest;
    try {
      upstream = client.request(apiUrl, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
      });
    } catch (e: any) {
      // 构造请求失败（协议/URL 非法等）：记日志 + 回 500，别让整个代理进程崩掉
      recordAndLog(jsonlPath, log, model, null, true, 0, String(e));
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
      resolve();
      return;
    }
    upstream.setTimeout(STREAM_IDLE_TIMEOUT_MS); // 空闲超时（长停顿不误杀）

    const finish = () => resolve();

    upstream.on("error", (e: Error) => {
      recordAndLog(jsonlPath, log, model, null, true, 0, String(e));
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      finish();
    });

    upstream.on("response", (upRes: http.IncomingMessage) => {
      const status = upRes.statusCode ?? 0;

      // 上游错误（如 401）：透传错误体 + 记录
      if (status >= 400) {
        const chunks: Buffer[] = [];
        upRes.on("data", (c) => chunks.push(c));
        upRes.on("end", () => {
          const err = Buffer.concat(chunks);
          if (!res.headersSent) {
            res.writeHead(status, {
              "Content-Type": upRes.headers["content-type"] ?? "application/json",
            });
            res.end(err);
          }
          recordAndLog(
            jsonlPath,
            log,
            model,
            null,
            true,
            status,
            err.toString("utf8").slice(0, 200),
          );
          maybeQueryBalance(auth, balancePath, status === 402, log);
          finish();
        });
        return;
      }

      // 成功：发响应头，chunked 流式
      if (!res.headersSent) {
        res.writeHead(status, {
          "Content-Type": upRes.headers["content-type"] ?? "text/event-stream",
          "Transfer-Encoding": "chunked",
          "Access-Control-Allow-Origin": "*",
        });
      }

      const extractor = new SseUsageExtractor();
      let clientGone = false;
      res.on("close", () => {
        clientGone = true; // 客户端断开：停止转发，继续读完上游
      });

      upRes.on("data", (chunk: Buffer) => {
        if (!clientGone) {
          try {
            res.write(chunk); // Node chunked 自动分帧
          } catch {
            clientGone = true;
          }
        }
        extractor.push(chunk.toString("utf8"));
      });

      upRes.on("end", () => {
        extractor.flush();
        if (!clientGone) {
          try {
            res.end();
          } catch {
            /* ignore */
          }
        } else {
          try {
            res.end();
          } catch {
            /* ignore */
          }
        }
        recordAndLog(jsonlPath, log, model, extractor.usage, true, status);
        maybeQueryBalance(auth, balancePath, false, log);
        finish();
      });

      upRes.on("error", (e: Error) => {
        extractor.flush();
        recordAndLog(jsonlPath, log, model, extractor.usage, true, 0, String(e));
        try {
          if (!clientGone) res.end();
        } catch {
          /* ignore */
        }
        finish();
      });
    });

    upstream.write(body);
    upstream.end();
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
