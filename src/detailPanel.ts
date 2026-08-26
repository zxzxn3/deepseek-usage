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
} from "./stats";
import { ChartKind, ChartPayload, buildChartPayload } from "./chartData";
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

function render(
  data: DetailData,
  range: PanelRange,
  kind: ChartKind,
  custom: CustomSelection,
  showBalance: boolean,
  showLatency: boolean,
  assets: { chart: string; init: string; css: string },
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
      ? `<tr><td colspan="6" class="muted">${t("noRecordsToday")}</td></tr>`
      : s.models
          .slice()
          .sort((a, b) => b.m.cost - a.m.cost)
          .map(
            (r) => `<tr>
        <td>${esc(r.name)}</td>
        <td class="num">${fmtNum(r.m.p)}/${fmtNum(r.m.c)}</td>
        <td class="num">${fmtNum(r.m.t)}/${fmtNum(r.m.ch)}</td>
        <td class="num">${money(r.m.cost)}/${money(r.m.chCost)}</td>
        <td class="num">${r.m.avgMs > 0 ? fmtMs(r.m.avgMs) : "—"}</td>
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
            return `<tr>
        <td class="num">${beijingTime(r.ts)}</td>
        <td>${esc(r.model)}</td>
        <td class="num">${fmtNum(r.prompt_tokens)}/${fmtNum(r.completion_tokens)}</td>
        <td class="num">${fmtNum(r.total_tokens)}/${fmtNum(r.cache_hit_tokens)}</td>
        <td class="num">${money(rc.cost)}/${money(rc.chCost)}</td>
        <td class="num">${r.ms != null ? fmtMs(r.ms) : "—"}</td>
        <td class="num">${r.status}</td>
        <td>${err}</td>
      </tr>`;
          })
          .join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="${assets.css}">
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
    <thead><tr><th>${t("model")}</th><th class="num">${t("input")}/${t("output")}</th><th class="num">${t("totalCache")}</th><th class="num">${t("costCache")}</th><th class="num">${t("avgLatency")}</th><th class="num">${t("count")}</th></tr></thead>
    <tbody>${modelRows}</tbody>
  </table>

  <h2>${t("recentRequests")}</h2>
  <table>
    <thead><tr><th class="num">${t("time")}</th><th>${t("model")}</th><th class="num">${t("input")}/${t("output")}</th><th class="num">${t("totalCache")}</th><th class="num">${t("costCache")}</th><th class="num">${t("latency")}</th><th class="num">${t("status")}</th><th>${t("error")}</th></tr></thead>
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
<script src="${assets.chart}"></script>
<script src="${assets.init}"></script>`
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
  const chartInitUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "out", "chartInit.js"),
  );
  const cssUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "out", "detail.css"),
  );
  const assets = {
    chart: chartUri.toString(),
    init: chartInitUri.toString(),
    css: cssUri.toString(),
  };
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
      assets,
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
