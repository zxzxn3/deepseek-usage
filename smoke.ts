// 冒烟测试：SSE 解析、今日聚合、峰值计费、真流式透传（mock 上游 + 断连续读）。
// 运行：npm run smoke
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { appendRecord, TailReader, UsageRecord } from "./src/jsonl";
import { aggregateRange } from "./src/stats";
import { isPeakBeijing, costFromUsage } from "./src/pricing";
import { SseUsageExtractor } from "./src/server/sse";
import { startProxyServer } from "./src/server/proxyServer";

const check = (name: string, got: unknown, exp: unknown) => {
  const ok = String(got) === String(exp);
  console.log(`${ok ? "OK  " : "FAIL"} ${name} → ${got} ${ok ? "" : `(期望 ${exp})`}`);
};

// ---------- 1. SSE 解析单元测试 ----------
{
  const ex = new SseUsageExtractor();
  // 一条 data 行被切成两半（跨块）
  ex.push('data: {"usage":{"prompt_tokens":100,"completion_tokens":50,');
  ex.push('"total_tokens":150,"prompt_cache_hit_tokens":90,"prompt_cache_miss_tokens":10}}\n\n');
  ex.push('data: [DONE]\n\n');
  ex.flush();
  check("SSE 跨块提取 usage.total_tokens", ex.usage?.total_tokens, 150);
  check("SSE 提取 usage.cache_hit", ex.usage?.prompt_cache_hit_tokens, 90);
}

// ---------- 2. 聚合 + 峰值（沿用既有逻辑） ----------
{
  const file = path.join(os.tmpdir(), "dsu-smoke2.jsonl");
  fs.rmSync(file, { force: true });
  const BEIJING_OFFSET_MS = 8 * 3600 * 1000;
  const bjTs = (now: Date, off: number, hour: number) => {
    const bt = new Date(now.getTime() + BEIJING_OFFSET_MS + off * 86400000);
    const utc = Date.UTC(bt.getUTCFullYear(), bt.getUTCMonth(), bt.getUTCDate(), hour) - BEIJING_OFFSET_MS;
    return new Date(utc).toISOString();
  };
  const now = new Date();
  const peakTs = bjTs(now, 0, 10);
  const offTs = bjTs(now, 0, 20);
  const yestTs = bjTs(now, -1, 10);
  const rec = (ts: string): UsageRecord => ({
    ts, model: "deepseek-v4-flash", prompt_tokens: 1_000_000, completion_tokens: 0,
    total_tokens: 1_000_000, cache_hit_tokens: 0, cache_miss_tokens: 1_000_000,
    stream: false, status: 200,
  });
  appendRecord(file, rec(peakTs));
  appendRecord(file, rec(offTs));
  appendRecord(file, rec(yestTs));
  const reader = new TailReader(file);
  const s = aggregateRange(reader.readNew(), "today", now);
  const expPeak = costFromUsage(1_000_000, 0, 0, 1_000_000, "deepseek-v4-flash", isPeakBeijing(peakTs));
  const expOff = costFromUsage(1_000_000, 0, 0, 1_000_000, "deepseek-v4-flash", isPeakBeijing(offTs));
  check("isPeak 周二10:00 北京", isPeakBeijing("2026-08-25T02:00:00.000Z"), true);
  check("isPeak 周六10:00 北京", isPeakBeijing("2026-08-29T02:00:00.000Z"), false);
  check("聚合: 今天两条、昨天排除", s.p, 2_000_000);
  check("聚合: 费用（峰值现算）", s.cost.toFixed(4), (expPeak + expOff).toFixed(4));
  fs.rmSync(file, { force: true });
}

// ---------- 3. 真流式透传：mock 上游 + 代理 + 客户端 ----------
async function runStreaming() {
  // 3a. mock 上游（DeepSeek 假体）：按段发 SSE，含跨块 usage 行与 [DONE]
  const fakeUp = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let payload: any = {};
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {}
      const includeUsage = payload.stream_options?.include_usage === true;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (s: string) => new Promise<void>((r) => res.write(s, () => setTimeout(r, 15)));
      void (async () => {
        await send('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
        await send('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
        if (includeUsage) {
          // 跨块：usage 行分两次写，验证代理跨块缓冲
          await send('data: {"usage":{"prompt_tokens":100,"completion_tokens":50,');
          await send('"total_tokens":150,"prompt_cache_hit_tokens":90,"prompt_cache_miss_tokens":10}}\n\n');
        }
        await send("data: [DONE]\n\n");
        res.end();
      })().catch(() => {});
    });
  });
  await new Promise<void>((r) => fakeUp.listen(0, "127.0.0.1", r));
  const fakePort = (fakeUp.address() as any).port;

  const jsonl = path.join(os.tmpdir(), "dsu-stream.jsonl");
  fs.rmSync(jsonl, { force: true });
  const proxy = await startProxyServer({
    port: 0,
    jsonlPath: jsonl,
    apiUrl: `http://127.0.0.1:${fakePort}/v1/chat/completions`,
    log: () => {},
  });
  const proxyPort = (proxy.address() as any).port;

  // 3b. 正常流式客户端
  const body1 = JSON.stringify({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });
  const res1 = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: proxyPort, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test" } },
      (s) => {
        const cs: Buffer[] = [];
        s.on("data", (c) => cs.push(c));
        s.on("end", () => resolve({ status: s.statusCode ?? 0, text: Buffer.concat(cs).toString("utf8") }));
      },
    );
    r.on("error", reject);
    r.write(body1);
    r.end();
  });
  check("流式: 状态 200", res1.status, 200);
  check("流式: 透传内容含 Hel", res1.text.includes("Hel"), true);
  check("流式: 透传内容含 lo", res1.text.includes("lo"), true);
  check("流式: 透传 [DONE]", res1.text.includes("[DONE]"), true);

  const reader1 = new TailReader(jsonl);
  const recs1 = reader1.readNew();
  check("流式: JSONL 记 1 条", recs1.length, 1);
  check("流式: usage 落库 total=150", recs1[0]?.total_tokens, 150);
  check("流式: usage 落库 cache_hit=90", recs1[0]?.cache_hit_tokens, 90);
  check("流式: ms 落库为耗时数字", typeof recs1[0]?.ms === "number" && (recs1[0]?.ms as number) > 0, true);

  // 3c. 客户端断连：读第一段后销毁，代理应继续读完上游并落 usage
  const body2 = JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true });
  await new Promise<void>((resolve) => {
    const r = http.request(
      { host: "127.0.0.1", port: proxyPort, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test" } },
      (s) => {
        s.once("data", () => {
          r.destroy(); // 客户端中途断开
        });
        s.on("close", () => resolve());
      },
    );
    r.write(body2);
    r.end();
  });
  await new Promise((r) => setTimeout(r, 800)); // 等代理读完上游并落库
  const recs2 = reader1.readNew(); // 增量：应只返回断连那条
  check("断连: 代理仍读完并记录 usage", recs2.length, 1);
  check("断连: 记录的 total=150", recs2[0]?.total_tokens, 150);

  proxy.close();
  fakeUp.close();
}

// ---------- 4. 非流式透传 + 402 触发余额查询 ----------
async function runNonStream402() {
  // 余额 mock（DEEPSEEK_BALANCE_URL 指向这里）
  const balSrv = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ is_available: false, balance_infos: [{ currency: "CNY", total_balance: "1.23" }] }));
  });
  await new Promise<void>((r) => balSrv.listen(0, "127.0.0.1", r));
  const balUrl = `http://127.0.0.1:${(balSrv.address() as any).port}/user/balance`;

  // 上游 mock：x-mode=err 时回 402，否则 200 + usage
  const upSrv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.headers["x-mode"] === "err") {
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "insufficient balance" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "x",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70 },
      }));
    });
  });
  await new Promise<void>((r) => upSrv.listen(0, "127.0.0.1", r));
  const upPort = (upSrv.address() as any).port;

  const jsonl = path.join(os.tmpdir(), "dsu-nonstream.jsonl");
  const balFile = path.join(os.tmpdir(), "dsu-nonstream-bal.jsonl");
  fs.rmSync(jsonl, { force: true });
  fs.rmSync(balFile, { force: true });
  const proxy = await startProxyServer({
    port: 0,
    jsonlPath: jsonl,
    balancePath: balFile,
    apiUrl: `http://127.0.0.1:${upPort}/v1/chat/completions`,
    balanceUrl: balUrl,
    log: () => {},
  });
  const proxyPort = (proxy.address() as any).port;

  const post = (body: unknown, headers: Record<string, string>) =>
    new Promise<{ status: number }>((resolve, reject) => {
      const r = http.request(
        { host: "127.0.0.1", port: proxyPort, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test", ...headers } },
        (s) => {
          s.resume();
          s.on("end", () => resolve({ status: s.statusCode ?? 0 }));
        },
      );
      r.on("error", reject);
      r.write(JSON.stringify(body));
      r.end();
    });

  const okBody = { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: false };
  await post(okBody, {});
  const recs = fs.readFileSync(jsonl, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  check("非流式: 记 1 条", recs.length, 1);
  check("非流式: stream=false", recs[0].stream, false);
  check("非流式: usage total=140", recs[0].total_tokens, 140);
  check("非流式: ms 落库为耗时数字", typeof recs[0].ms === "number" && recs[0].ms > 0, true);

  // 402 → 强制查余额 → balance.jsonl 写入
  await post({ model: "deepseek-v4-flash", messages: [], stream: false }, { "x-mode": "err" });
  await new Promise((r) => setTimeout(r, 300)); // 等异步查余额
  const bals = fs.readFileSync(balFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  check("402: balance.jsonl 记 1 条", bals.length, 1);
  check("402: 余额 totalCny=1.23", bals[0].totalCny, 1.23);
  check("402: isAvailable=false", bals[0].isAvailable, false);

  proxy.close();
  upSrv.close();
  balSrv.close();
}

runStreaming().then(() => runNonStream402()).then(() => {
  console.log("smoke done");
});
