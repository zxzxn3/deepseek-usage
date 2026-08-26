// 今日（北京时间）统计聚合。JSONL 存原始事实，费用在此按峰值现算。
import { UsageRecord } from "./jsonl";
import { modelPrice, costFromUsage, isPeakBeijing } from "./pricing";

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

/** 任意时刻记录的计价结果（不含"今天"门控），供任意区间聚合用。 */
function costsAt(
  r: UsageRecord,
  tsMs: number,
): {
  pt: number;
  ct: number;
  tt: number;
  ch: number;
  cm: number;
  cost: number;
  chCost: number;
  cmCost: number;
  outCost: number;
} {
  const pt = r.prompt_tokens ?? 0;
  const ct = r.completion_tokens ?? 0;
  const tt = r.total_tokens ?? 0;
  const ch = r.cache_hit_tokens ?? 0;
  const cm = r.cache_miss_tokens ?? 0;
  const peak = isPeakBeijing(new Date(tsMs));
  const f = peak ? 2 : 1;
  const cost = costFromUsage(pt, ct, ch, cm, r.model, peak);
  const pr = modelPrice(r.model);
  return {
    pt,
    ct,
    tt,
    ch,
    cm,
    cost,
    chCost: (ch * pr.cache_hit) / 1e6 * f,
    cmCost: (cm * pr.cache_miss) / 1e6 * f,
    outCost: (ct * pr.output) / 1e6 * f,
  };
}

/** 一条记录的今日计价结果；不属于北京时间今天则返回 null。 */
function perRecordCosts(
  r: UsageRecord,
): {
  pt: number;
  ct: number;
  tt: number;
  ch: number;
  cost: number;
  chCost: number;
} | null {
  const tsMs = Date.parse(r.ts);
  const now = new Date();
  const start = beijingDayStartUtcMs(now);
  const end = start + 24 * 3600 * 1000;
  if (!Number.isFinite(tsMs) || tsMs < start || tsMs >= end) return null;
  return costsAt(r, tsMs);
}

/** 把一条记录并入今日统计（仅当属于北京时间今天）。返回是否并入。 */
export function addRecord(stats: TodayStats, r: UsageRecord): boolean {
  const c = perRecordCosts(r);
  if (!c) return false;
  stats.p += c.pt;
  stats.c += c.ct;
  stats.t += c.tt;
  stats.ch += c.ch;
  stats.cost += c.cost;
  stats.chCost += c.chCost;
  return true;
}

export interface ModelStats {
  p: number;
  c: number;
  t: number;
  ch: number;
  cost: number;
  chCost: number;
  count: number;
}

export function newModelStats(): ModelStats {
  return { p: 0, c: 0, t: 0, ch: 0, cost: 0, chCost: 0, count: 0 };
}

/** 并入按模型统计（仅当属于北京时间今天）。返回是否并入。 */
export function addModelRecord(m: ModelStats, r: UsageRecord): boolean {
  const c = perRecordCosts(r);
  if (!c) return false;
  m.p += c.pt;
  m.c += c.ct;
  m.t += c.tt;
  m.ch += c.ch;
  m.cost += c.cost;
  m.chCost += c.chCost;
  m.count += 1;
  return true;
}

/** 一次性聚合整批记录（如日切换后重建）。 */
export function aggregateToday(records: UsageRecord[]): TodayStats {
  const s = newTodayStats();
  for (const r of records) addRecord(s, r);
  return s;
}

// ---------------------------------------------------------------------------
// 任意区间聚合（today / week / month / all），供明细面板使用
// ---------------------------------------------------------------------------
export type RangeKey = "today" | "week" | "month" | "all";
export type PanelRange = RangeKey | "custom";
export const RANGE_KEYS: RangeKey[] = ["today", "week", "month", "all"];
export type CustomMode = "day" | "week" | "month";

/** 区间窗口（北京时间）：day=今日一整天；week/month=自然周/月整段（含未来空槽，图轴稳定）；all=全部。 */
export function rangeWindow(
  key: RangeKey,
  now = new Date(),
): { start: number; end: number } {
  const DAY = 24 * 3600 * 1000;
  const dayStart = beijingDayStartUtcMs(now);
  switch (key) {
    case "today":
      return { start: dayStart, end: dayStart + DAY };
    case "week": {
      const wd = new Date(dayStart + BEIJING_OFFSET_MS).getUTCDay(); // 北京星期几，周日=0
      const weekStart = dayStart - ((wd + 6) % 7) * DAY;
      return { start: weekStart, end: weekStart + 7 * DAY };
    }
    case "month": {
      const bt = new Date(dayStart + BEIJING_OFFSET_MS);
      return {
        start:
          Date.UTC(bt.getUTCFullYear(), bt.getUTCMonth(), 1) - BEIJING_OFFSET_MS,
        end:
          Date.UTC(bt.getUTCFullYear(), bt.getUTCMonth() + 1, 1) -
          BEIJING_OFFSET_MS,
      };
    }
    case "all":
      return { start: 0, end: now.getTime() };
  }
}

/** "全部"图表的时间跨度：从最早记录的北京日开始，到今晚结束（避免 1970 年起画海量空槽）。 */
export function allChartWindow(
  records: UsageRecord[],
  now = new Date(),
): { start: number; end: number } {
  const DAY = 24 * 3600 * 1000;
  let minTs = now.getTime();
  for (const r of records) {
    const t = Date.parse(r.ts);
    if (Number.isFinite(t) && t < minTs) minTs = t;
  }
  return {
    start: beijingDayStartUtcMs(new Date(minTs)),
    end: beijingDayStartUtcMs(now) + DAY,
  };
}

/** 北京时间某日历日 0 点对应的 UTC 毫秒。dateStr = YYYY-MM-DD。 */
export function beijingDateStartUtcMs(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - BEIJING_OFFSET_MS;
}

/** 自定义区间窗口：day=该北京日；week=该日所在周（周一~周日）；month=该日所在月。 */
export function customRangeWindow(
  dateStr: string,
  mode: CustomMode,
): { start: number; end: number } {
  const DAY = 24 * 3600 * 1000;
  const dayStart = beijingDateStartUtcMs(dateStr);
  if (mode === "day") return { start: dayStart, end: dayStart + DAY };
  if (mode === "week") {
    const wd = new Date(dayStart + BEIJING_OFFSET_MS).getUTCDay(); // 北京星期几，周日=0
    const weekStart = dayStart - ((wd + 6) % 7) * DAY;
    return { start: weekStart, end: weekStart + 7 * DAY };
  }
  const [y, m] = dateStr.split("-").map(Number);
  return {
    start: Date.UTC(y, m - 1, 1) - BEIJING_OFFSET_MS,
    end: Date.UTC(y, m, 1) - BEIJING_OFFSET_MS,
  };
}

export interface TimeBucket {
  label: string; // 今天=HH，其它=MM-DD（北京时间）
  start: number; // 桶起点（UTC ms）
  cost: number;
  tokens: number;
  // 堆叠分量（费用元 / 词元）：缓存命中·缓存未命中·输出
  costCacheHit: number;
  costCacheMiss: number;
  costOutput: number;
  tokCacheHit: number;
  tokCacheMiss: number;
  tokOutput: number;
}

export interface RangeStats {
  p: number;
  c: number;
  t: number;
  ch: number;
  cost: number;
  chCost: number;
  count: number;
  count402: number; // 区间内 402（余额不足）请求数
  models: { name: string; m: ModelStats }[];
  recent: UsageRecord[]; // 区间内最近 60 条（新→旧）
  rows: UsageRecord[]; // 区间内全部（新→旧），供 CSV 导出
  buckets: TimeBucket[]; // 时间桶：今天按小时，其余按天
}

/** 聚合任意区间：汇总 + 按模型 + 最近请求 + 时间桶。 */
function aggregateWindow(
  records: UsageRecord[],
  start: number,
  end: number,
  hourly: boolean,
): RangeStats {
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  const bucketMs = hourly ? HOUR : DAY;

  const stats = newTodayStats();
  const modelMap = new Map<string, ModelStats>();
  const rows: UsageRecord[] = [];
  const bucketMap = new Map<number, TimeBucket>();
  let count402 = 0;

  const bucketLabel = (ms: number) => {
    const d = new Date(ms + BEIJING_OFFSET_MS);
    if (hourly) return String(d.getUTCHours()).padStart(2, "0");
    return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
      d.getUTCDate(),
    ).padStart(2, "0")}`;
  };

  for (const r of records) {
    const tsMs = Date.parse(r.ts);
    if (!Number.isFinite(tsMs) || tsMs < start || tsMs >= end) continue;
    if (r.status === 402) count402 += 1;
    const c = costsAt(r, tsMs);

    stats.p += c.pt;
    stats.c += c.ct;
    stats.t += c.tt;
    stats.ch += c.ch;
    stats.cost += c.cost;
    stats.chCost += c.chCost;

    let m = modelMap.get(r.model);
    if (!m) {
      m = newModelStats();
      modelMap.set(r.model, m);
    }
    m.p += c.pt;
    m.c += c.ct;
    m.t += c.tt;
    m.ch += c.ch;
    m.cost += c.cost;
    m.chCost += c.chCost;
    m.count += 1;

    rows.push(r);

    // 桶按北京时间对齐（当天 00:00 / 整点），与图表完整时间轴对齐；
    // 否则北京 00:00-08:00 的记录会被分到前一天的 UTC 桶。
    const bStart =
      Math.floor((tsMs + BEIJING_OFFSET_MS) / bucketMs) * bucketMs -
      BEIJING_OFFSET_MS;
    let b = bucketMap.get(bStart);
    if (!b) {
      b = {
        label: bucketLabel(bStart),
        start: bStart,
        cost: 0,
        tokens: 0,
        costCacheHit: 0,
        costCacheMiss: 0,
        costOutput: 0,
        tokCacheHit: 0,
        tokCacheMiss: 0,
        tokOutput: 0,
      };
      bucketMap.set(bStart, b);
    }
    b.cost += c.cost;
    b.tokens += c.tt;
    b.costCacheHit += c.chCost;
    b.costCacheMiss += c.cmCost;
    b.costOutput += c.outCost;
    b.tokCacheHit += c.ch;
    b.tokCacheMiss += c.cm;
    b.tokOutput += c.ct;
  }

  rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const buckets = [...bucketMap.values()].sort((a, b) =>
    a.label < b.label ? -1 : a.label > b.label ? 1 : 0,
  );

  return {
    p: stats.p,
    c: stats.c,
    t: stats.t,
    ch: stats.ch,
    cost: stats.cost,
    chCost: stats.chCost,
    count: rows.length,
    count402,
    models: [...modelMap.entries()].map(([name, m]) => ({ name, m })),
    recent: rows.slice(0, 60),
    rows,
    buckets,
  };
}

/** 快捷区间（today/week/month/all）聚合。 */
export function aggregateRange(
  records: UsageRecord[],
  key: RangeKey,
  now = new Date(),
): RangeStats {
  const { start, end } = rangeWindow(key, now);
  // 天/周视图按小时柱；月/全部按天柱
  return aggregateWindow(records, start, end, key === "today" || key === "week");
}

/** 自定义日期聚合：day=该日（按小时桶）；week/month=按天桶。 */
export function aggregateCustom(
  records: UsageRecord[],
  dateStr: string,
  mode: CustomMode,
): RangeStats {
  const { start, end } = customRangeWindow(dateStr, mode);
  // 天/周自定义视图按小时柱；月按天柱
  return aggregateWindow(records, start, end, mode === "day" || mode === "week");
}
