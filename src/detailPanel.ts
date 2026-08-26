// 明细面板（Webview）：区间选择（today/week/month/all）+ 时间桶图 + 汇总卡 + 按模型 + 最近请求 + 导出 CSV。
// 数据由扩展侧 getData(range) 回调提供；每 5s 自动刷新。
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  ModelStats,
  RangeKey,
  RANGE_KEYS,
  RangeStats,
  CustomMode,
  PanelRange,
} from "./stats";
import { UsageRecord } from "./jsonl";
import {
  modelPrice,
  costFromUsage,
  isPeakBeijing,
  currentBeijingSegment,
} from "./pricing";
import { fmtNum } from "./server/termfmt";
import { t } from "./i18n";
import { Currency, fmtMoney } from "./currency";
import { getLiveRate } from "./rate";

export interface ModelRow {
  name: string;
  m: ModelStats;
}

export interface DetailData extends RangeStats {
  peakNow: boolean;
  balance: { totalCny: number | null; isAvailable: boolean; ts: string } | null;
  balanceHistory: { ts: number; cny: number }[]; // 区间内余额快照（升序），供余额曲线叠加
  win: { start: number; end: number }; // 当前数据区间（UTC ms）
  chartWin: { start: number; end: number }; // 图表完整时间轴（含未来空槽）
}

const BEIJING_OFFSET_MS = 8 * 3600 * 1000;
const RECENT_DISPLAY = 30;

export interface CustomSelection {
  date: string; // YYYY-MM-DD（北京时间）
  mode: CustomMode;
}

function todayBeijingStr(): string {
  const n = new Date(Date.now() + BEIJING_OFFSET_MS);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${n.getUTCFullYear()}-${p(n.getUTCMonth() + 1)}-${p(n.getUTCDate())}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** YYYY-MM-DD（北京）→ ISO 周 "YYYY-Www"（周选择器用）。 */
function isoWeekOf(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d)); // 北京日历日按 UTC 计算 ISO 周（与时区无关）
  const dayNum = date.getUTCDay() || 7; // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // 移到本周四
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad2(week)}`;
}

/** ISO 周 "YYYY-Www" → 该周周一（北京）YYYY-MM-DD；解析失败返回 null。 */
function isoWeekToDateStr(value: string): string | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const week1Monday = jan4.getTime() - (jan4Dow - 1) * 86400000;
  const monday = new Date(week1Monday + (week - 1) * 7 * 86400000);
  return `${monday.getUTCFullYear()}-${pad2(monday.getUTCMonth() + 1)}-${pad2(
    monday.getUTCDate(),
  )}`;
}

/** YYYY-MM-DD（北京）→ "YYYY-MM"（月选择器值）。 */
function dateStrToMonth(dateStr: string): string {
  return dateStr.slice(0, 7);
}

/** "YYYY-MM"（月选择器值）→ "YYYY-MM-01"。 */
function monthToDateStr(value: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(value.trim());
  return m ? `${m[1]}-${m[2]}-01` : "";
}

function beijingTime(ts: string): string {
  const d = new Date(Date.parse(ts) + BEIJING_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function money(n: number, digits = 4): string {
  const cur = vscode.workspace
    .getConfiguration("deepseekStatusBar")
    .get<Currency>("currency", "cny");
  const rate =
    getLiveRate() ??
    vscode.workspace
      .getConfiguration("deepseekStatusBar")
      .get<number>("cnyPerUsd", 6.74);
  return fmtMoney(n, cur, rate, digits);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function rowCosts(r: UsageRecord): { cost: number; chCost: number } {
  const tsMs = Date.parse(r.ts);
  const peak = isPeakBeijing(new Date(tsMs));
  const cost = costFromUsage(
    r.prompt_tokens ?? 0,
    r.completion_tokens ?? 0,
    r.cache_hit_tokens ?? 0,
    r.cache_miss_tokens ?? 0,
    r.model,
    peak,
  );
  const chCost =
    ((r.cache_hit_tokens ?? 0) * modelPrice(r.model).cache_hit) / 1e6 *
    (peak ? 2 : 1);
  return { cost, chCost };
}

type ChartKind = "cost" | "tokens";

/** 按时间图表（SVG）：用量柱 + 可选余额曲线叠加；柱常驻半透明。 */
function usageChartHtml(
  buckets: {
    label: string;
    start: number;
    cost: number;
    tokens: number;
    costCacheHit: number;
    costCacheMiss: number;
    costOutput: number;
    tokCacheHit: number;
    tokCacheMiss: number;
    tokOutput: number;
  }[],
  kind: ChartKind,
  barHourly: boolean,
  labelHourly: boolean,
  chartWin: { start: number; end: number },
  balance: { ts: number; cny: number }[],
  showBalance: boolean,
): string {
  if (buckets.length === 0) {
    return `<div class="muted">${t("noRequestsToday")}</div>`;
  }
  const W = 720;
  const H = 170;
  const PAD_L = 46;
  const PAD_R = showBalance && balance.length > 0 ? 52 : 8;
  const PAD_T = 8;
  const BL = 16; // 底部标签区
  const plotL = PAD_L;
  const plotR = W - PAD_R;
  const plotT = PAD_T;
  const plotB = H - BL;
  const span = Math.max(1, chartWin.end - chartWin.start);
  const x = (ts: number) =>
    plotL + ((ts - chartWin.start) / span) * (plotR - plotL);
  const bucketMs = barHourly ? 3600 * 1000 : 24 * 3600 * 1000;
  const slotCount = Math.max(1, Math.ceil(span / bucketMs));
  const slotW = (plotR - plotL) / slotCount;
  const vals = buckets.map((b) => (kind === "cost" ? b.cost : b.tokens));
  const maxV = Math.max(1, ...vals);
  const yV = (v: number) => plotB - (v / maxV) * (plotB - plotT);
  const fmt = (n: number) => (kind === "cost" ? money(n) : fmtNum(n));
  const bucketByStart = new Map(buckets.map((b) => [b.start, b]));
  const slotLabel = (s: number) => {
    const d = new Date(s + BEIJING_OFFSET_MS);
    return labelHourly
      ? pad2(d.getUTCHours())
      : `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  };
  // 天标签只标在每天 0 点那根柱下方（周视图：小时柱 + 天标签）
  const isDayStart = (s: number) => {
    const d = new Date(s + BEIJING_OFFSET_MS);
    return d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
  };
  const labelStep = Math.max(1, Math.ceil(slotCount / 24));
  const titleLabel = (s: number) => {
    const d = new Date(s + BEIJING_OFFSET_MS);
    const day = `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    return barHourly ? `${day} ${pad2(d.getUTCHours())}:00` : day;
  };

  // 左 y 轴（用量）：网格线 + 刻度标签
  let yAxis = "";
  const gridTicks = [0, 0.25, 0.5, 0.75, 1];
  for (const t of gridTicks) {
    const yPos = plotB - t * (plotB - plotT);
    yAxis += `<line x1="${plotL}" x2="${plotR}" y1="${yPos}" y2="${yPos}" stroke="var(--vscode-panel-border)" stroke-opacity="0.35"/>`;
    yAxis += `<text x="${plotL - 6}" y="${yPos + 3}" font-size="9" fill="var(--vscode-foreground)" opacity="0.65" text-anchor="end">${fmt(
      t * maxV,
    )}</text>`;
  }
  yAxis += `<text x="${plotL - 6}" y="${plotT - 4}" font-size="9" fill="var(--vscode-foreground)" opacity="0.65" text-anchor="end">${
    kind === "cost" ? t("cost") : t("totalToken")
  }</text>`;

  // 完整时间轴：每个槽位都分配固定宽度并标注（过去/未来无数据也显示标签，柱宽稳定）
  let slots = "";
  for (let i = 0; i < slotCount; i++) {
    const s = chartWin.start + i * bucketMs;
    const b = bucketByStart.get(s);
    const v = b ? (kind === "cost" ? b.cost : b.tokens) : 0;
    const bx = x(s);
    const w = Math.max(1, slotW - 2);
    const showLabel = labelHourly
      ? i % labelStep === 0
      : barHourly
        ? isDayStart(s)
        : i % labelStep === 0;
    const label = showLabel
      ? `<text x="${(bx + slotW / 2).toFixed(1)}" y="${H - 4}" font-size="10" fill="var(--vscode-foreground)" opacity="0.6" text-anchor="middle">${slotLabel(
          s,
        )}</text>`
      : "";
    let bar = "";
    if (v > 0 && b) {
      // 堆叠三段：下=缓存命中输入，中=缓存未命中输入，上=输出
      const segs =
        kind === "cost"
          ? [
              { v: b.costCacheHit, c: "var(--vscode-charts-blue)" },
              { v: b.costCacheMiss, c: "var(--vscode-charts-green)" },
              { v: b.costOutput, c: "var(--vscode-charts-purple)" },
            ]
          : [
              { v: b.tokCacheHit, c: "var(--vscode-charts-blue)" },
              { v: b.tokCacheMiss, c: "var(--vscode-charts-green)" },
              { v: b.tokOutput, c: "var(--vscode-charts-purple)" },
            ];
      const title = `${titleLabel(s)}: ${fmt(v)}`;
      let yCursor = plotB;
      for (const seg of segs) {
        const segH = (seg.v / maxV) * (plotB - plotT);
        if (segH > 0) {
          const y0 = yCursor - segH;
          bar += `<rect x="${bx.toFixed(1)}" y="${y0.toFixed(1)}" width="${w.toFixed(
            1,
          )}" height="${segH.toFixed(1)}" fill="${seg.c}" fill-opacity="0.75"><title>${title}</title></rect>`;
          yCursor -= segH;
        }
      }
    }
    slots += bar + label;
  }

  // 余额曲线叠加（右 y 轴）
  let overlay = "";
  let yAxisRight = "";
  if (showBalance && balance.length > 0) {
    const cnys = balance.map((p) => p.cny);
    const maxB = Math.max(...cnys, 0);
    const cSpan = maxB || 1; // 从 0 到最高点
    // 负余额按 0 处理（落在图底，不显示 0 以下部分）
    const yB = (c: number) =>
      plotB - (Math.max(0, c) / cSpan) * (plotB - plotT);
    const clampX = (ts: number) => Math.max(plotL, Math.min(plotR, x(ts)));
    const pts = balance
      .map((p) => `${clampX(p.ts).toFixed(1)},${yB(p.cny).toFixed(1)}`)
      .join(" ");
    const dot =
      balance.length === 1
        ? `<circle cx="${clampX(balance[0].ts).toFixed(1)}" cy="${yB(
            balance[0].cny,
          ).toFixed(1)}" r="2.5" fill="var(--vscode-charts-orange)"/>`
        : "";
    overlay = `<polyline points="${pts}" fill="none" stroke="var(--vscode-charts-orange)" stroke-width="1.5"/>${dot}`;
    const bTicks = maxB > 0 ? [0, maxB] : [0];
    for (const c of bTicks) {
      const yPos = yB(c);
      yAxisRight += `<text x="${plotR + 6}" y="${yPos + 3}" font-size="9" fill="var(--vscode-charts-orange)" opacity="0.9">${money(
        c,
        2,
      )}</text>`;
    }
    yAxisRight += `<text x="${plotR + 6}" y="${plotT - 4}" font-size="9" fill="var(--vscode-charts-orange)">${t(
      "balanceCurve",
    )}</text>`;
  }

  // 水平随面板宽度缩放（高度固定）；preserveAspectRatio=none 使其横向拉伸
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block">${yAxis}${slots}${overlay}${yAxisRight}</svg>`;
}

function render(
  data: DetailData,
  range: PanelRange,
  kind: ChartKind,
  custom: CustomSelection,
  showBalance: boolean,
): string {
  const s = data;
  const today = new Date(Date.now() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
  const seg = currentBeijingSegment(new Date());
  const peakBadge = seg.peak
    ? `<span class="badge peak">${t("peakBadge")}</span>`
    : `<span class="badge off">${t("offpeakBadge")}</span>`;
  const segBadge = `<span class="badge seg" title="${t(
    "customRangeNote",
  )}">${seg.range}</span>`;

  const bal = data.balance;
  const balanceHtml = (() => {
    if (!bal || bal.totalCny === null) {
      return `<div class="banner">${t("balance")}: ${t("balanceNone")}</div>`;
    }
    const lowThreshold = vscode.workspace
      .getConfiguration("deepseekStatusBar")
      .get<number>("lowBalanceWarnCny", 10);
    const low = lowThreshold > 0 && bal.totalCny < lowThreshold;
    const when = bal.ts ? ` · ${beijingTime(bal.ts)}` : "";
    return `<div class="banner${low ? " warn" : ""}">${t(
      "balance",
    )}: ${money(bal.totalCny, 2)}${when}${low ? " · " + t("balanceLow") : ""}</div>`;
  })();
  // 402 是"当前余额"警示：只在 today 视图显示；历史/自定义区间不弹横幅
  // （历史 402 仍可在"最近请求"表格的 status 列看到 s402/o402）。
  const err402 =
    range === "today" && s.count402 > 0
      ? `<div class="banner warn">${t("err402", { n: s.count402 })}</div>`
      : "";

  // 按钮即粒度：custom 模式下高亮当前粒度的按钮（day↔today）
  const activeKey: RangeKey =
    range === "custom"
      ? custom.mode === "day"
        ? "today"
        : (custom.mode as RangeKey)
      : range;
  const rangeBtn = (k: RangeKey) =>
    `<button class="seg${k === activeKey ? " active" : ""}" data-range="${k}">${t(
      "range" + k[0].toUpperCase() + k.slice(1),
    )}</button>`;
  const kindBtn = (k: ChartKind) =>
    `<button class="seg${k === kind ? " active" : ""}" data-kind="${k}">${
      k === "cost" ? t("chartCost") : t("chartTokens")
    }</button>`;

  // 日期选择器跟随粒度按钮：日→date、周→week、月→month
  let gran: "day" | "week" | "month" = "day";
  if (range === "week") gran = "week";
  else if (range === "month") gran = "month";
  else if (range === "custom" && custom.mode !== "day")
    gran = custom.mode === "week" ? "week" : "month";
  const inputType = gran === "day" ? "date" : gran === "week" ? "week" : "month";
  const inputValue =
    gran === "day"
      ? custom.date
      : gran === "week"
        ? isoWeekOf(custom.date)
        : dateStrToMonth(custom.date);

  // 柱粒度与底部标签：周视图=小时柱+天标签；天视图=小时柱+小时标签；月/全部=天柱+天标签
  const barHourly =
    range === "today" ||
    range === "week" ||
    (range === "custom" && (custom.mode === "day" || custom.mode === "week"));
  const labelHourly =
    barHourly &&
    (range === "today" || (range === "custom" && custom.mode === "day"));

  const card = (k: string, v: string) =>
    `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`;

  const summary =
    card(t("cost"), money(s.cost)) +
    card(t("cacheCost"), money(s.chCost)) +
    card(t("totalToken"), fmtNum(s.t)) +
    card(t("cacheToken"), fmtNum(s.ch)) +
    card(t("input"), fmtNum(s.p)) +
    card(t("output"), fmtNum(s.c)) +
    card(t("requests"), String(s.count));

  const modelRows =
    s.models.length === 0
      ? `<tr><td colspan="7" class="muted">${t("noRecordsToday")}</td></tr>`
      : s.models
          .slice()
          .sort((a, b) => b.m.cost - a.m.cost)
          .map(
            (r) => `<tr>
        <td>${esc(r.name)}</td>
        <td class="num">${fmtNum(r.m.p)}</td>
        <td class="num">${fmtNum(r.m.c)}</td>
        <td class="num">${fmtNum(r.m.t)}/${fmtNum(r.m.ch)}</td>
        <td class="num">${money(r.m.cost)}</td>
        <td class="num">${money(r.m.chCost)}</td>
        <td class="num">${r.m.count}</td>
      </tr>`,
          )
          .join("");

  const recent = s.recent.slice(0, RECENT_DISPLAY);
  const recentRows =
    recent.length === 0
      ? `<tr><td colspan="7" class="muted">${t("noRequestsToday")}</td></tr>`
      : recent
          .map((r) => {
            const rc = rowCosts(r);
            const err = r.error
              ? `<span class="err">✗ ${esc(r.error.slice(0, 60))}</span>`
              : "";
            const mode = r.stream ? "s" : "o";
            return `<tr>
        <td class="num">${beijingTime(r.ts)}</td>
        <td>${esc(r.model)}</td>
        <td class="num">${fmtNum(r.prompt_tokens)}/${fmtNum(r.completion_tokens)}</td>
        <td class="num">${fmtNum(r.total_tokens)}/${fmtNum(r.cache_hit_tokens)}</td>
        <td class="num">${money(rc.cost)}</td>
        <td class="num">${mode}${r.status}</td>
        <td>${err}</td>
      </tr>`;
          })
          .join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); }
  h1 { font-size: 15px; margin: 0 0 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  h2 { font-size: 13px; margin: 18px 0 6px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  .toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
  .seg { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 3px 12px; cursor: pointer; font-size: 12px; }
  .seg.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 3px 12px; cursor: pointer; font-size: 12px; }
  .spacer { flex: 1; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; }
  .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px 12px; min-width: 100px; }
  .card .k { font-size: 11px; opacity: .8; }
  .card .v { font-size: 15px; font-weight: 600; margin-top: 2px; font-family: var(--vscode-editor-font-family); }
  .badge { font-size: 11px; padding: 1px 8px; border-radius: 9px; }
  .badge.peak { background: rgba(255,90,90,.18); color: #ff6b6b; }
  .badge.off { background: rgba(80,220,140,.16); color: #3fce6b; }
  .badge.seg { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); }
  .datepick { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 2px 6px; font-size: 12px; }
  .switch { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--vscode-foreground); cursor: pointer; }
  .switch input { display: none; }
  .switch .track { width: 30px; height: 16px; border-radius: 9px; background: var(--vscode-checkbox-border); position: relative; transition: background .15s; flex: none; }
  .switch .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--vscode-checkbox-foreground); transition: transform .15s; }
  .switch input:checked + .track { background: var(--vscode-checkbox-background); }
  .switch input:checked + .track::after { transform: translateX(14px); }
  .legend { display: flex; gap: 14px; font-size: 11px; margin: 4px 0 6px; color: var(--vscode-foreground); opacity: .8; }
  .legend span { display: inline-flex; align-items: center; gap: 4px; }
  .legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .banner { padding: 6px 10px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); margin-bottom: 10px; font-size: 12px; }
  .banner.warn { background: rgba(255,90,90,.12); border-color: #ff6b6b; color: #ff6b6b; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  th { opacity: .7; font-weight: 500; }
  td.num, th.num { text-align: right; font-family: var(--vscode-editor-font-family); }
  .err { color: #ff6b6b; }
  .muted { opacity: .7; font-size: 11px; }
</style>
</head>
<body data-range="${range}" data-date="${custom.date}" data-mode="${custom.mode}">
  <h1>${t("panelTitle")} <span class="muted">${today}</span> ${peakBadge} ${segBadge}
    <span class="spacer"></span>
    <button class="btn" id="export">${t("exportCsv")}</button>
  </h1>

  ${balanceHtml}
  ${err402}

  <div class="toolbar">
    ${RANGE_KEYS.map(rangeBtn).join("")}
    <input
      type="${inputType}"
      id="date"
      class="datepick"
      value="${inputValue}"
      title="${t("customRangeNote")}"
    />
    <label class="switch" title="${t("balanceCurve")}">
      <input type="checkbox" id="showBalance" ${showBalance ? "checked" : ""} />
      <span class="track"></span>
      <span>${t("balanceCurve")}</span>
    </label>
    <span class="spacer"></span>
    ${kindBtn("cost")}
    ${kindBtn("tokens")}
  </div>

  <h2>${t("byTime")}</h2>
  <div class="legend">
    <span><i style="background:var(--vscode-charts-blue)"></i>${t("cacheHit")}</span>
    <span><i style="background:var(--vscode-charts-green)"></i>${t("cacheMiss")}</span>
    <span><i style="background:var(--vscode-charts-purple)"></i>${t("output")}</span>
  </div>
  ${usageChartHtml(
    s.buckets,
    kind,
    barHourly,
    labelHourly,
    s.chartWin,
    s.balanceHistory,
    showBalance,
  )}

  <div class="cards">${summary}</div>

  <h2>${t("byModel")}</h2>
  <table>
    <thead><tr><th>${t("model")}</th><th class="num">${t("input")}</th><th class="num">${t("output")}</th><th class="num">${t("totalCache")}</th><th class="num">${t("cost")}</th><th class="num">${t("cacheCost")}</th><th class="num">${t("count")}</th></tr></thead>
    <tbody>${modelRows}</tbody>
  </table>

  <h2>${t("recentRequests")}</h2>
  <table>
    <thead><tr><th class="num">${t("time")}</th><th>${t("model")}</th><th class="num">${t("input")}/${t("output")}</th><th class="num">${t("totalCache")}</th><th class="num">${t("cost")}</th><th class="num">${t("status")}</th><th>${t("error")}</th></tr></thead>
    <tbody>${recentRows}</tbody>
  </table>

  <p class="muted">${t("autoRefreshNote")}</p>
  <p class="muted">${t("balanceDelayNote")}</p>
  <script>
    const vscode = acquireVsCodeApi();
    setInterval(() => vscode.postMessage({ type: "refresh" }), 5000);
    document.querySelectorAll(".seg[data-range]").forEach((b) =>
      b.addEventListener("click", () => vscode.postMessage({ type: "range", range: b.dataset.range })));
    document.querySelectorAll(".seg[data-kind]").forEach((b) =>
      b.addEventListener("click", () => vscode.postMessage({ type: "chart", kind: b.dataset.kind })));
    document.getElementById("date").addEventListener("change", (e) =>
      vscode.postMessage({ type: "date", date: e.target.value, inputType: e.target.type }));
    document.getElementById("showBalance").addEventListener("change", (e) =>
      vscode.postMessage({ type: "balance", show: e.target.checked }));
    document.getElementById("export").addEventListener("click", () => {
      const b = document.body.dataset;
      vscode.postMessage({ type: "exportCsv", range: b.range, date: b.date, mode: b.mode });
    });
  </script>
</body>
</html>`;
}

async function exportCsv(
  getData: (range: PanelRange, custom: CustomSelection) => DetailData,
  range: string,
  custom: CustomSelection,
) {
  const data = getData(range as PanelRange, custom);
  const csv = buildCsv(data.rows);
  const stamp = new Date(Date.now() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(
      path.join(os.homedir(), `deepseek-usage-${range}-${stamp}.csv`),
    ),
    filters: { "CSV (*.csv)": ["csv"] },
  });
  if (!uri) return;
  fs.writeFileSync(uri.fsPath, csv, "utf8");
  void vscode.window.showInformationMessage(
    t("exportDone", { n: data.rows.length, path: uri.fsPath }),
  );
}

function buildCsv(rows: UsageRecord[]): string {
  const head = [
    "ts_utc",
    "model",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "cache_hit_tokens",
    "cache_miss_tokens",
    "stream",
    "status",
    "error",
    "cost_cny",
    "cache_cost_cny",
  ];
  const cell = (v: string | number | null | undefined): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head.join(",")];
  for (const r of rows) {
    const rc = rowCosts(r);
    lines.push(
      [
        r.ts,
        r.model,
        r.prompt_tokens,
        r.completion_tokens,
        r.total_tokens,
        r.cache_hit_tokens,
        r.cache_miss_tokens,
        r.stream ? 1 : 0,
        r.status,
        r.error ?? "",
        rc.cost.toFixed(6),
        rc.chCost.toFixed(6),
      ]
        .map(cell)
        .join(","),
    );
  }
  return lines.join("\n");
}

export function openDetailPanel(
  getData: (range: PanelRange, custom: CustomSelection) => DetailData,
): void {
  const panel = vscode.window.createWebviewPanel(
    "deepseekStatusBar.detail",
    t("panelTitle"),
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  let range: PanelRange = "today";
  let custom: CustomSelection = { date: todayBeijingStr(), mode: "day" };
  let kind: ChartKind = "cost";
  let showBalance = false;
  const refresh = () => {
    panel.webview.html = render(
      getData(range, custom),
      range,
      kind,
      custom,
      showBalance,
    );
  };
  refresh();
  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === "range" && RANGE_KEYS.includes(msg.range as RangeKey)) {
      range = msg.range as RangeKey;
      // 点击粒度按钮时同步 custom.mode，使日期选择用当前按钮的粒度
      if (msg.range !== "all") {
        custom = {
          ...custom,
          mode: (msg.range === "today" ? "day" : msg.range) as CustomMode,
        };
      }
      refresh();
    } else if (msg.type === "chart") {
      kind = msg.kind === "tokens" ? "tokens" : "cost";
      refresh();
    } else if (msg.type === "date") {
      if (typeof msg.date === "string" && msg.date) {
        let converted: string | null = null;
        if (msg.inputType === "week") converted = isoWeekToDateStr(msg.date);
        else if (msg.inputType === "month") converted = monthToDateStr(msg.date);
        else if (/^\d{4}-\d{2}-\d{2}$/.test(msg.date)) converted = msg.date;
        if (converted) {
          custom = { ...custom, date: converted };
          range = "custom";
          refresh();
        }
      }
    } else if (msg.type === "balance") {
      showBalance = msg.show === true;
      refresh();
    } else if (msg.type === "exportCsv") {
      void exportCsv(
        getData,
        msg.range as string,
        {
          date: typeof msg.date === "string" && msg.date ? msg.date : custom.date,
          mode:
            msg.mode === "day" || msg.mode === "week" || msg.mode === "month"
              ? (msg.mode as CustomMode)
              : custom.mode,
        },
      );
    } else if (msg.type === "refresh") {
      refresh();
    }
  });
}
