// 今日（北京时间）统计聚合。JSONL 存原始事实，费用在此按峰值现算。
import { UsageRecord } from "./jsonl";
import { PRICING, DEFAULT_MODEL, costFromUsage, isPeakBeijing } from "./pricing";

export interface TodayStats {
  p: number;
  c: number;
  t: number;
  ch: number;
  cost: number;
  chCost: number;
}

const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

/** 北京时间"今天"0 点对应的 UTC 毫秒。 */
export function beijingDayStartUtcMs(now: Date): number {
  const bt = new Date(now.getTime() + BEIJING_OFFSET_MS);
  const dayStart = Date.UTC(bt.getUTCFullYear(), bt.getUTCMonth(), bt.getUTCDate());
  return dayStart - BEIJING_OFFSET_MS;
}

export function newTodayStats(): TodayStats {
  return { p: 0, c: 0, t: 0, ch: 0, cost: 0, chCost: 0 };
}

/** 把一条记录并入今日统计（仅当属于北京时间今天）。返回是否并入。 */
export function addRecord(stats: TodayStats, r: UsageRecord): boolean {
  const tsMs = Date.parse(r.ts);
  const now = new Date();
  const start = beijingDayStartUtcMs(now);
  const end = start + 24 * 3600 * 1000;
  if (!Number.isFinite(tsMs) || tsMs < start || tsMs >= end) return false;

  const pt = r.prompt_tokens ?? 0;
  const ct = r.completion_tokens ?? 0;
  const tt = r.total_tokens ?? 0;
  const ch = r.cache_hit_tokens ?? 0;
  const cm = r.cache_miss_tokens ?? 0;
  const peak = isPeakBeijing(new Date(tsMs));

  stats.p += pt;
  stats.c += ct;
  stats.t += tt;
  stats.ch += ch;
  stats.cost += costFromUsage(pt, ct, ch, cm, r.model, peak);
  const pr = PRICING[r.model] ?? PRICING[DEFAULT_MODEL];
  stats.chCost += (ch * pr.cache_hit) / 1e6 * (peak ? 2 : 1);
  return true;
}

/** 一次性聚合整批记录（如日切换后重建）。 */
export function aggregateToday(records: UsageRecord[]): TodayStats {
  const s = newTodayStats();
  for (const r of records) addRecord(s, r);
  return s;
}
