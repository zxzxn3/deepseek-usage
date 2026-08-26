// 官方定价表与费用计算（DeepSeek，20260803T000000）。
// - 高峰价 = 空闲价 × 2；高峰 = 北京时间周一~五 9-12、14-18。
// - 单位：元 / 百万 tokens。

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
dayjs.extend(utc);

export interface ModelPrice {
  cache_hit: number; // 输入缓存命中
  cache_miss: number; // 输入未命中
  output: number;
}

export const PRICING: Record<string, ModelPrice> = {
  "deepseek-v4-flash": { cache_hit: 0.05, cache_miss: 1.5, output: 4.5 },
  "deepseek-v4-pro": { cache_hit: 0.15, cache_miss: 4.5, output: 13.5 },
  "deepseek-v4-flash-vision-exp": { cache_hit: 0.05, cache_miss: 1.5, output: 4.5 },
};

export const DEFAULT_MODEL = "deepseek-v4-flash";

export type PriceOverrides = Record<string, Partial<ModelPrice>>;

// 生效定价表：默认官方价 + 用户配置覆盖（扩展/代理启动时 setPricingTable 注入）
let activeTable: Record<string, ModelPrice> = PRICING;

/** 默认表合并用户覆盖，得到完整生效表。 */
export function applyOverrides(
  overrides?: PriceOverrides,
): Record<string, ModelPrice> {
  const t: Record<string, ModelPrice> = { ...PRICING };
  for (const [m, o] of Object.entries(overrides ?? {})) {
    t[m] = { ...(t[m] ?? t[DEFAULT_MODEL]), ...o };
  }
  return t;
}

export function setPricingTable(table: Record<string, ModelPrice>): void {
  activeTable = table;
}

export function resetPricingTable(): void {
  activeTable = PRICING;
}

/** 取某模型生效价（缺失回退默认模型）。 */
export function modelPrice(model: string): ModelPrice {
  return activeTable[model] ?? activeTable[DEFAULT_MODEL];
}

// 北京时间用 dayjs 的 UTC 模式偏移表示（字段即北京值，不受宿主时区影响）
const bj = (ts: Date | string | number): dayjs.Dayjs =>
  dayjs.utc(ts).add(8, "hour");

/** tsUtc（Date 或 ISO 字符串）是否落在北京时间高峰时段（周一~五 9-12、14-18）。 */
export function isPeakBeijing(tsUtc: Date | string): boolean {
  const bt = bj(tsUtc);
  const wd = bt.day(); // Sun=0..Sat=6
  const h = bt.hour();
  if (wd === 0 || wd === 6) return false; // 周六/周日
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

export interface PeakSegment {
  peak: boolean;
  range: string; // 北京时间当前计费段，如 "09:00-12:00"
}

/** 北京时间当前所处计费段：高峰=周一~五 9-12、14-18，其余闲时。 */
export function currentBeijingSegment(tsUtc: Date | string): PeakSegment {
  const bt = bj(tsUtc);
  const wd = bt.day();
  const hm = bt.hour() + bt.minute() / 60;
  if (wd === 0 || wd === 6) return { peak: false, range: "00:00-24:00" };
  if (hm >= 9 && hm < 12) return { peak: true, range: "09:00-12:00" };
  if (hm >= 12 && hm < 14) return { peak: false, range: "12:00-14:00" };
  if (hm >= 14 && hm < 18) return { peak: true, range: "14:00-18:00" };
  if (hm >= 18) return { peak: false, range: "18:00-24:00" };
  // 凌晨属于跨夜闲时段：前一天 18:00 开始，至今早 09:00
  return { peak: false, range: "18:00-09:00" };
}

/** 精确 usage 计费；peak=True 按高峰价 ×2。返回本次请求费用（元）。 */
export function costFromUsage(
  promptTokens: number,
  completionTokens: number,
  cacheHitTokens: number,
  cacheMissTokens: number,
  model = DEFAULT_MODEL,
  peak = false,
): number {
  const p = modelPrice(model);
  const f = peak ? 2.0 : 1.0;
  return (
    (cacheMissTokens * p.cache_miss +
      cacheHitTokens * p.cache_hit +
      completionTokens * p.output) /
      1e6 *
    f
  );
}
