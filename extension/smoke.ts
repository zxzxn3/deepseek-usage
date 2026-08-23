// 开发冒烟测试：验证 JSONL 读写、今日（北京时间）聚合、峰值计费。
// 运行：npx esbuild smoke.ts --bundle --format=cjs --platform=node --outfile=out/smoke.js && node out/smoke.js
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { appendRecord, TailReader, UsageRecord } from "./src/jsonl";
import { aggregateToday, newTodayStats, addRecord } from "./src/stats";
import { isPeakBeijing, costFromUsage } from "./src/pricing";

const file = path.join(os.tmpdir(), "dsu-smoke.jsonl");
fs.rmSync(file, { force: true });

const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

// 构造"北京某日 hour 点"对应的 UTC ISO（dayOffset: 0=今天, -1=昨天）
function bjTs(now: Date, dayOffset: number, hour: number): string {
  const bt = new Date(now.getTime() + BEIJING_OFFSET_MS + dayOffset * 24 * 3600 * 1000);
  const utc = Date.UTC(bt.getUTCFullYear(), bt.getUTCMonth(), bt.getUTCDate(), hour) - BEIJING_OFFSET_MS;
  return new Date(utc).toISOString();
}

const now = new Date();
const peakTs = bjTs(now, 0, 10); // 今天北京 10:00
const offTs = bjTs(now, 0, 20); // 今天北京 20:00
const yestTs = bjTs(now, -1, 10); // 昨天北京 10:00 → 应被"今天"排除

function rec(ts: string): UsageRecord {
  return {
    ts,
    model: "deepseek-v4-flash",
    prompt_tokens: 1_000_000,
    completion_tokens: 0,
    total_tokens: 1_000_000,
    cache_hit_tokens: 0,
    cache_miss_tokens: 1_000_000,
    stream: false,
    status: 200,
  };
}

// 期望费用按同一套定价逻辑现算（不依赖今天星期几）
const expPeakCost = costFromUsage(1_000_000, 0, 0, 1_000_000, "deepseek-v4-flash", isPeakBeijing(peakTs));
const expOffCost = costFromUsage(1_000_000, 0, 0, 1_000_000, "deepseek-v4-flash", isPeakBeijing(offTs));

appendRecord(file, rec(peakTs));
appendRecord(file, rec(offTs));
appendRecord(file, rec(yestTs));

const reader = new TailReader(file);
const records = reader.readNew();
const s = aggregateToday(records);

const check = (name: string, got: unknown, exp: unknown) => {
  const ok = String(got) === String(exp);
  console.log(`${ok ? "OK  " : "FAIL"} ${name} → ${got} ${ok ? "" : `(期望 ${exp})`}`);
};

check("isPeak 周二10:00（2026-08-25 北京）", isPeakBeijing("2026-08-25T02:00:00.000Z"), true);
check("isPeak 周二20:00（北京）", isPeakBeijing("2026-08-25T12:00:00.000Z"), false);
check("isPeak 周六10:00（北京）", isPeakBeijing("2026-08-29T02:00:00.000Z"), false);
check("读到的记录数", records.length, 3);
check("today.p（两条今天，昨天排除）", s.p, 2_000_000);
check("today.t", s.t, 2_000_000);
check("today.cost（现算峰值）", s.cost.toFixed(4), (expPeakCost + expOffCost).toFixed(4));

// 增量读取：再追加一条，readNew 只返回新增
appendRecord(file, rec(offTs));
const more = reader.readNew();
check("增量 readNew 只返回 1 条", more.length, 1);
check("增量并入后 cost", (() => { const st = newTodayStats(); addRecord(st, more[0]); return st.cost.toFixed(4); })(), expOffCost.toFixed(4));

// 半行（写一半）不应被解析
fs.appendFileSync(file, '{"ts":"2026-08-25T1', "utf8");
check("半行被跳过", reader.readNew().length, 0);
fs.appendFileSync(file, '3:00:00.000Z","model":"deepseek-v4-flash","prompt_tokens":100,"completion_tokens":0,"total_tokens":100,"cache_hit_tokens":0,"cache_miss_tokens":100,"stream":false,"status":200}\n', "utf8");
check("补全后半行后读到", reader.readNew().length, 1);

fs.rmSync(file, { force: true });
console.log("smoke done");
