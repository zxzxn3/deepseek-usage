// 本地 OpenAI 兼容代理服务器。
// 支持：非流式转发 + 真流式透传（chunked / SSE 跨块缓冲 / 客户端断连续读 / 空闲超时）。
// R5 hook：log 回调即"可选终端"预留点。
import * as http from "http";
import * as https from "https";
import { appendRecord, UsageRecord } from "../jsonl";
import { SseUsageExtractor } from "./sse";

const DEFAULT_API_URL = "https://api.deepseek.com/chat/completions";
const STREAM_IDLE_TIMEOUT_MS = 600 * 1000; // 流式等下一个字节的最大空闲时间

export interface ProxyServerOptions {
  port: number;
  jsonlPath: string;
  apiUrl?: string;
  log?: (line: string) => void;
}

export function startProxyServer(
  opts: ProxyServerOptions,
): Promise<http.Server> {
  const { port, jsonlPath, log = console.log } = opts;
  const apiUrl = opts.apiUrl ?? process.env.DEEPSEEK_API_URL ?? DEFAULT_API_URL;
  const server = http.createServer((req, res) => {
    void handle(req, res, apiUrl, jsonlPath, log);
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
    `[${new Date().toISOString()}] ${model} p ${f.pt} c ${f.ct} ` +
      `t ${f.tt} cH ${f.ch} | ${stream ? "s" : "o"} ${status}` +
      (error ? `  ✗ ${error}` : ""),
  );
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  apiUrl: string,
  jsonlPath: string,
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
    await handleStream(req, res, apiUrl, jsonlPath, log, model, payload);
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
