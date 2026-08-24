// termfmt.ts — 代理输出格式化（对齐表格行），对齐 Python 版 termfmt.py 的观感。
// 输出面板/管道是纯文本（无 ANSI 色），这里保留：列对齐 / k-M 缩写 / ￥费用 / 状态列。
import { modelPrice, costFromUsage, isPeakBeijing } from "../pricing";
import { Currency, moneyPair } from "../currency";

let currency: Currency = "cny";
let cnyPerUsd = 6.74;
export function setCurrency(c: Currency, rate: number): void {
  currency = c;
  cnyPerUsd = rate;
}

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

/** 显示宽度：全角/中日韩按 2 列，保证 ￥、中文参与时列对齐（≈ Python east_asian_width F/W）。 */
export function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w += c > 0x2e7f ? 2 : 1; // >U+2E7F 基本覆盖中日韩表意/全角区
  }
  return w;
}

function pad(s: string, width: number, align: "<" | ">" = "<"): string {
  const p = width - dispWidth(s);
  if (p <= 0) return s;
  return align === "<" ? s + " ".repeat(p) : " ".repeat(p) + s;
}

/** 模型名简写：d4f / d4p / d4fv；未知去掉 deepseek-v4- 前缀并截断到 8 字符。 */
const MODEL_SHORT: Record<string, string> = {
  "deepseek-v4-flash": "d4f",
  "deepseek-v4-pro": "d4p",
  "deepseek-v4-flash-vision-exp": "d4fv",
};
export function shortModel(model: string): string {
  const s =
    MODEL_SHORT[model] ??
    model.replace(/^deepseek-v4-/, "").replace(/^deepseek-/, "");
  return s.length > 8 ? s.slice(0, 8) : s;
}

/** 表头（英文为主）；与行共用同一套列宽保证对齐。 */
export function makeHdr(): string {
  return (
    pad("Time", 10) +
    pad("Model", 6, ">") +
    pad("Prompt/Comp", 13, ">") +
    pad("Total/Cache", 16, ">") +
    pad("Cost/Cache", 18, ">") +
    pad("Status", 6, ">")
  );
}

export function makeSep(hdr: string): string {
  return "-".repeat(dispWidth(hdr));
}

export interface FmtRowInput {
  model: string;
  pt: number | null;
  ct: number | null;
  tt: number | null;
  ch: number | null;
  cm: number | null;
  stream: boolean;
  status: number;
  error?: string;
  ts?: string; // 覆盖时间（HH:MM:SS）；默认取当前本地时间
  peak?: boolean; // 覆盖高峰判断；默认按当前北京时间
}

/** 把一次请求的 usage + 费用格式化成一行：时间 | 输入/输出 | token总/缓存 | 费用总/缓存 | 状态。 */
export function fmtRow(inp: FmtRowInput): string {
  const ts = inp.ts ?? new Date().toTimeString().slice(0, 8); // HH:MM:SS（本地，同 Python）
  const peak = inp.peak ?? isPeakBeijing(new Date());
  const { pt, ct, tt, ch, cm, model, stream, status } = inp;
  const p_s = fmtNum(pt);
  const c_s = fmtNum(ct);
  const t_s = fmtNum(tt);
  const ch_s = fmtNum(ch);

  let pcCol: string;
  let tokCol: string;
  let costCol: string;
  if (inp.error) {
    pcCol = "—";
    tokCol = "—";
    costCol = "—";
  } else {
    pcCol = `${p_s}/${c_s}`;
    tokCol = `${t_s}/${ch_s}`;
    if (pt !== null && ct !== null && ch !== null && cm !== null) {
      const cost = costFromUsage(pt, ct, ch, cm, model, peak);
      const pr = modelPrice(model);
      const chCost = (ch * pr.cache_hit) / 1e6 * (peak ? 2.0 : 1.0);
      costCol = moneyPair(cost, chCost, currency, cnyPerUsd);
    } else {
      costCol = "—";
    }
  }

  const mode = stream ? "s" : "o";
  let row =
    pad(ts, 10) +
    pad(shortModel(model), 8, ">") +
    pad(pcCol, 13, ">") +
    pad(tokCol, 16, ">") +
    pad(costCol, 18, ">") +
    pad(`${mode}${status}`, 6, ">");
  if (inp.error) row += "  ✗ " + inp.error.split(/\r?\n/)[0].slice(0, 80);
  return row;
}
