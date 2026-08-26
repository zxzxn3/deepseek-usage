// 明细面板（Webview）：区间选择（today/week/month/all）+ 时间桶图 + 汇总卡 + 按模型 + 最近请求 + 导出 CSV。
// 数据由扩展侧 getData(range) 回调提供；每 5s 自动刷新。
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import isoWeek from "dayjs/plugin/isoWeek";

dayjs.extend(utc);
dayjs.extend(isoWeek);
import {
  ModelStats,
  RangeKey,
  RANGE_KEYS,
  RangeStats,
  CustomMode,
  PanelRange,
  TimeBucket,
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

// 北京时间用 dayjs 的 UTC 模式偏移表示（字段即北京值，不受宿主时区影响）
const bj = (ts: Date | string | number): dayjs.Dayjs =>
  dayjs.utc(ts).add(8, "hour");
const RECENT_DISPLAY = 30;

export interface CustomSelection {
  date: string; // YYYY-MM-DD（北京时间）
  mode: CustomMode;
}

function todayBeijingStr(): string {
  return bj(new Date()).format("YYYY-MM-DD");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** YYYY-MM-DD（北京）→ ISO 周 "YYYY-Www"（周选择器用）。 */
function isoWeekOf(dateStr: string): string {
  const d = dayjs.utc(dateStr); // 北京日历日按 UTC 计算 ISO 周（与时区无关）
  return `${d.isoWeekYear()}-W${pad2(d.isoWeek())}`;
}

/** ISO 周 "YYYY-Www" → 该周周一（北京）YYYY-MM-DD；解析失败返回 null。 */
function isoWeekToDateStr(value: string): string | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(value.trim());
  if (!m) return null;
  // ISO 第 1 周必然包含 1 月 4 日：取 1/4 所在周周一，再推到目标周
  const monday = dayjs
    .utc(`${m[1]}-01-04`)
    .isoWeekday(1)
    .add(Number(m[2]) - 1, "week");
  return monday.format("YYYY-MM-DD");
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
  const bt = bj(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(bt.hour())}:${p(bt.minute())}:${p(bt.second())}`;
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

function fmtMs(ms: number): string {
  return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
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

/** 交给 webview 里 Chart.js 渲染的数据（时间槽 + 三段堆叠 + 可选余额线）。 */
interface ChartPayload {
  labels: string[];
  showTick: boolean[];
  hit: number[];
  miss: number[];
  out: number[];
  format: ChartKind;
  latency: (number | null)[]; // 每槽平均耗时（毫秒），无请求或未开启为 null
  latencyOn: boolean;
  balance: (number | null)[] | { x: number; y: number }[] | null;
  useTimeAxis: boolean; // 余额线是否画在独立线性时间轴（月/全部视图按小时）
  chartStart: number;
  chartEnd: number;
  names: { hit: string; miss: string; out: string; balance: string; latency: string };
}

/** 由聚合桶构建 Chart.js 数据；无数据返回 null（面板显示占位文本）。 */
function buildChartPayload(
  buckets: TimeBucket[],
  kind: ChartKind,
  barHourly: boolean,
  labelHourly: boolean,
  chartWin: { start: number; end: number },
  balance: { ts: number; cny: number }[],
  showBalance: boolean,
  showLatency: boolean,
): ChartPayload | null {
  if (buckets.length === 0) return null;
  const bucketMs = barHourly ? 3600 * 1000 : 24 * 3600 * 1000;
  const slotCount = Math.max(1, Math.ceil((chartWin.end - chartWin.start) / bucketMs));
  const bucketByStart = new Map(buckets.map((b) => [b.start, b]));
  const compactDay = !labelHourly; // 非小时标签的视图（周/月/全部）：标签只显示日号
  const slotLabel = (s: number) => {
    const bt = bj(s);
    if (compactDay) return String(bt.date());
    return labelHourly
      ? pad2(bt.hour())
      : `${pad2(bt.month() + 1)}-${pad2(bt.date())}`;
  };
  const isDayStart = (s: number) => {
    const bt = bj(s);
    return bt.hour() === 0 && bt.minute() === 0;
  };
  const labelStep = Math.max(1, Math.ceil(slotCount / 24));
  const labels: string[] = [];
  const showTick: boolean[] = [];
  const hit: number[] = [];
  const miss: number[] = [];
  const out: number[] = [];
  const latency: (number | null)[] = [];
  const slotStarts: number[] = [];
  for (let i = 0; i < slotCount; i++) {
    const s = chartWin.start + i * bucketMs;
    const b = bucketByStart.get(s);
    const show =
      labelHourly ? i % labelStep === 0
      : barHourly ? isDayStart(s)
      : i % labelStep === 0;
    labels.push(slotLabel(s));
    showTick.push(show);
    if (b) {
      hit.push(kind === "cost" ? b.costCacheHit : b.tokCacheHit);
      miss.push(kind === "cost" ? b.costCacheMiss : b.tokCacheMiss);
      out.push(kind === "cost" ? b.costOutput : b.tokOutput);
      latency.push(showLatency && b.avgMs > 0 ? b.avgMs : null);
    } else {
      hit.push(0);
      miss.push(0);
      out.push(0);
      latency.push(null);
    }
    slotStarts.push(s);
  }
  let balanceVals: (number | null)[] | { x: number; y: number }[] | null = null;
  let useTimeAxis = false;
  if (showBalance && balance.length > 0) {
    if (barHourly) {
      // 天/周视图：柱是小时，余额按小时槽平均，画在 category 轴
      const arr: (number | null)[] = [];
      for (let i = 0; i < slotCount; i++) {
        const s = slotStarts[i];
        let sum = 0;
        let n = 0;
        for (const p of balance) {
          if (p.ts >= s && p.ts < s + bucketMs) {
            sum += p.cny;
            n++;
          }
        }
        arr.push(n > 0 ? sum / n : null);
      }
      balanceVals = arr;
    } else {
      // 月/全部视图：柱是天，余额按小时点画在独立时间轴 xBal（已与天柱对齐）
      useTimeAxis = true;
      const HOUR = 3600 * 1000;
      const arr: { x: number; y: number }[] = [];
      const first = Math.floor(chartWin.start / HOUR) * HOUR;
      for (let t = first; t < chartWin.end; t += HOUR) {
        let sum = 0;
        let n = 0;
        for (const p of balance) {
          if (p.ts >= t && p.ts < t + HOUR) {
            sum += p.cny;
            n++;
          }
        }
        if (n > 0) arr.push({ x: t, y: sum / n });
      }
      balanceVals = arr;
    }
  }
  return {
    labels,
    showTick,
    hit,
    miss,
    out,
    format: kind,
    latency,
    latencyOn: showLatency,
    balance: balanceVals,
    useTimeAxis,
    chartStart: chartWin.start,
    chartEnd: chartWin.end,
    names: {
      hit: t("cacheHit"),
      miss: t("cacheMiss"),
      out: t("output"),
      balance: t("balanceCurve"),
      latency: t("avgLatency"),
    },
  };
}

function render(
  data: DetailData,
  range: PanelRange,
  kind: ChartKind,
  custom: CustomSelection,
  showBalance: boolean,
  showLatency: boolean,
  chartUri: string,
): string {
  const s = data;
  const today = bj(new Date()).format("YYYY-MM-DD");
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
  const payload = buildChartPayload(
    s.buckets,
    kind,
    barHourly,
    labelHourly,
    s.chartWin,
    s.balanceHistory,
    showBalance,
    showLatency,
  );

  const card = (k: string, v: string) =>
    `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`;

  const summary =
    card(t("cost"), money(s.cost)) +
    card(t("cacheCost"), money(s.chCost)) +
    card(t("totalToken"), fmtNum(s.t)) +
    card(t("cacheToken"), fmtNum(s.ch)) +
    card(t("input"), fmtNum(s.p)) +
    card(t("output"), fmtNum(s.c)) +
    card(t("requests"), String(s.count)) +
    card(t("avgLatency"), s.avgMs > 0 ? fmtMs(s.avgMs) : "—");

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
      ? `<tr><td colspan="8" class="muted">${t("noRequestsToday")}</td></tr>`
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
        <td class="num">${r.ms != null ? fmtMs(r.ms) : "—"}</td>
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
  .chart-box { position: relative; height: 160px; }
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
    ${
      range !== "all"
        ? `<input
      type="${inputType}"
      id="date"
      class="datepick"
      value="${inputValue}"
      title="${t("customRangeNote")}"
    />`
        : ""
    }
    <label class="switch" title="${t("balanceCurve")}">
      <input type="checkbox" id="showBalance" ${showBalance ? "checked" : ""} />
      <span class="track"></span>
      <span>${t("balanceCurve")}</span>
    </label>
    <label class="switch" title="${t("latencyCurve")}">
      <input type="checkbox" id="showLatency" ${showLatency ? "checked" : ""} />
      <span class="track"></span>
      <span>${t("latencyCurve")}</span>
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
    ${showBalance ? `<span><i style="background:var(--vscode-charts-orange)"></i>${t("balanceCurve")}</span>` : ""}
    ${showLatency ? `<span><i style="background:var(--vscode-charts-yellow)"></i>${t("avgLatency")}</span>` : ""}
  </div>
  ${
    payload
      ? `<div class="chart-box"><canvas id="usageChart"></canvas></div>`
      : `<div class="muted">${t("noRequestsToday")}</div>`
  }

  <div class="cards">${summary}</div>

  <h2>${t("byModel")}</h2>
  <table>
    <thead><tr><th>${t("model")}</th><th class="num">${t("input")}</th><th class="num">${t("output")}</th><th class="num">${t("totalCache")}</th><th class="num">${t("cost")}</th><th class="num">${t("cacheCost")}</th><th class="num">${t("count")}</th></tr></thead>
    <tbody>${modelRows}</tbody>
  </table>

  <h2>${t("recentRequests")}</h2>
  <table>
    <thead><tr><th class="num">${t("time")}</th><th>${t("model")}</th><th class="num">${t("input")}/${t("output")}</th><th class="num">${t("totalCache")}</th><th class="num">${t("cost")}</th><th class="num">${t("latency")}</th><th class="num">${t("status")}</th><th>${t("error")}</th></tr></thead>
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
    document.getElementById("showLatency").addEventListener("change", (e) =>
      vscode.postMessage({ type: "latency", show: e.target.checked }));
    document.getElementById("export").addEventListener("click", () => {
      const b = document.body.dataset;
      vscode.postMessage({ type: "exportCsv", range: b.range, date: b.date, mode: b.mode });
    });
  </script>
  ${
    payload
      ? `<script>window.__CHART = ${JSON.stringify(payload)};</script>
<script src="${chartUri}"></script>
<script>
  (function () {
    var d = window.__CHART;
    if (!d || typeof Chart === "undefined") return;
    var css = getComputedStyle(document.body);
    var col = function (v, f) { var s = css.getPropertyValue(v).trim(); return s || f; };
    var blue = col("--vscode-charts-blue", "#3794ff");
    var green = col("--vscode-charts-green", "#30a148");
    var purple = col("--vscode-charts-purple", "#b180d7");
    var orange = col("--vscode-charts-orange", "#ea5f00");
    var latColor = col("--vscode-charts-yellow", "#d7ba7d");
    var gridColor = col("--vscode-panel-border", "rgba(128,128,128,0.3)");
    var fmt = d.format === "cost"
      ? function (n) { return "￥" + (n || 0).toFixed(4); }
      : function (n) { n = n || 0; if (n < 1000) return String(n); if (n < 1000000) return (n / 1000).toFixed(1) + "k"; return (n / 1000000).toFixed(2) + "M"; };
    var alpha = function (hex, a) {
      if (hex[0] === "#" && hex.length === 7) {
        var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
        return "rgba(" + r + "," + g + "," + b + "," + a + ")";
      }
      return hex;
    };
    var barA = 0.55;
    var datasets = [];
    datasets.push({ label: d.names.hit, data: d.hit, backgroundColor: alpha(blue, barA), stack: "u" });
    datasets.push({ label: d.names.miss, data: d.miss, backgroundColor: alpha(green, barA), stack: "u" });
    datasets.push({ label: d.names.out, data: d.out, backgroundColor: alpha(purple, barA), stack: "u" });
    if (d.latencyOn) {
      datasets.push({ label: d.names.latency, type: "line", data: d.latency, xAxisID: "x", yAxisID: "yLat", borderColor: latColor, backgroundColor: "transparent", pointRadius: 0, borderWidth: 1.5, spanGaps: true, tension: 0 });
    }
    var scales = {
      x: { stacked: true, grid: { color: function (ctx) { return d.showTick[ctx.index] ? gridColor : "transparent"; } }, ticks: { autoSkip: false, maxRotation: 0, font: { size: 9 }, callback: function (v, i) { return d.showTick[i] ? d.labels[i] : ""; } } },
      y: { stacked: true, beginAtZero: true, grid: { color: gridColor }, ticks: { font: { size: 9 }, callback: function (v) { return fmt(v); } } },
    };
    if (d.latencyOn) {
      scales.yLat = { position: "right", beginAtZero: true, stacked: false, grid: { drawOnChartArea: false }, ticks: { font: { size: 9 }, color: latColor, callback: function (v) { return v + "ms"; } } };
    }
    if (d.balance && d.balance.length) {
      datasets.push({ label: d.names.balance, type: "line", data: d.balance, xAxisID: d.useTimeAxis ? "xBal" : "x", yAxisID: "yBal", borderColor: orange, backgroundColor: "transparent", pointRadius: 0, borderWidth: 1.5, spanGaps: true, tension: 0 });
      if (d.useTimeAxis) {
        scales.xBal = { type: "linear", min: d.chartStart, max: d.chartEnd, offset: false, display: false, ticks: { display: false }, grid: { drawOnChartArea: false } };
      }
      scales.yBal = { position: "right", beginAtZero: true, stacked: false, grid: { drawOnChartArea: false }, ticks: { font: { size: 9 }, color: orange, callback: function (v) { return "￥" + (v || 0).toFixed(2); } } };
    }
    new Chart(document.getElementById("usageChart"), {
      type: "bar",
      data: { labels: d.labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: (function () {
          var st = vscode.getState() || {};
          if (!st.chartPainted) { st.chartPainted = true; vscode.setState(st); return { duration: 500 }; }
          return false;
        })(),
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (ctx) { if (ctx.dataset.yAxisID === "yBal") return ctx.dataset.label + ": ￥" + (ctx.parsed.y || 0).toFixed(2); if (ctx.dataset.yAxisID === "yLat") return ctx.dataset.label + ": " + (ctx.parsed.y || 0) + "ms"; return ctx.dataset.label + ": " + fmt(ctx.parsed.y); } } },
        },
        scales: scales,
      },
    });
  })();
</script>`
      : ""
  }
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
  const stamp = bj(new Date()).format("YYYY-MM-DD");
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
  extensionUri: vscode.Uri,
): void {
  const panel = vscode.window.createWebviewPanel(
    "deepseekStatusBar.detail",
    t("panelTitle"),
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out")],
    },
  );
  const chartUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "out", "chart.umd.js"),
  );
  let range: PanelRange = "today";
  let custom: CustomSelection = { date: todayBeijingStr(), mode: "day" };
  let kind: ChartKind = "cost";
  let showBalance = false;
  let showLatency = false;
  const refresh = () => {
    panel.webview.html = render(
      getData(range, custom),
      range,
      kind,
      custom,
      showBalance,
      showLatency,
      chartUri.toString(),
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
    } else if (msg.type === "latency") {
      showLatency = msg.show === true;
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
