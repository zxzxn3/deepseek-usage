// 本地 OpenAI 兼容代理服务器（脚手架版）。
// 当前：非流式转发 + 落 JSONL；流式透传（chunked/SSE/断连续读）是 R1，未实现→501。
// R5 hook：log 回调即"可选终端"预留点——之后可把子进程 stdout 管道到 OutputChannel。
import * as http from "http";
import { appendRecord, UsageRecord } from "../jsonl";

const API_URL = "https://api.deepseek.com/chat/completions";

export interface ProxyServerOptions {
  port: number;
  jsonlPath: string;
  log?: (line: string) => void;
}

export function startProxyServer(
  opts: ProxyServerOptions,
): Promise<http.Server> {
  const { port, jsonlPath, log = console.log } = opts;
  const server = http.createServer((req, res) => {
    void handle(req, res, jsonlPath, log);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
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

  if (payload.stream) {
    // R1：流式透传尚未实现
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "streaming not implemented yet (R1)" }));
    return;
  }

  const auth = req.headers.authorization ?? "";
  const model = payload.model ?? "deepseek-v4-flash";

  try {
    const up = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const raw = Buffer.from(await up.arrayBuffer());

    let pt = null, ct = null, tt = null, ch = null, cm = null;
    try {
      const d = JSON.parse(raw.toString("utf8"));
      const u = d.usage ?? {};
      pt = u.prompt_tokens ?? null;
      ct = u.completion_tokens ?? null;
      tt = u.total_tokens ?? null;
      ch = u.prompt_cache_hit_tokens ?? null;
      cm = u.prompt_cache_miss_tokens ?? null;
    } catch {
      // 无 usage 字段
    }

    const rec: UsageRecord = {
      ts: new Date().toISOString(),
      model,
      prompt_tokens: pt,
      completion_tokens: ct,
      total_tokens: tt,
      cache_hit_tokens: ch,
      cache_miss_tokens: cm,
      stream: false,
      status: up.status,
    };
    appendRecord(jsonlPath, rec);
    log(
      `[${new Date().toISOString()}] ${model} p ${pt} c ${ct} ` +
        `cH ${ch} | s ${up.status}`,
    );

    res.writeHead(up.status, {
      "Content-Type": up.headers.get("content-type") ?? "application/json",
    });
    res.end(raw);
  } catch (e: any) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e) }));
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
