// 明细面板（Webview）：区间选择（today/week/month/all）+ 时间桶图 + 汇总卡 + 按模型 + 最近请求 + 导出 CSV。
// 数据由扩展侧 getData(range) 回调提供；每 5s 自动刷新。
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ModelStats, RangeKey, RANGE_KEYS, RangeStats } from "./stats";
import { UsageRecord } from "./jsonl";
import { modelPrice, costFromUsage, isPeakBeijing } from "./pricing";
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
}

const BEIJING_OFFSET_MS = 8 * 3600 * 1000;
const RECENT_DISPLAY = 30;

function beijingTime(ts: string): string {
  const d = new Date(Date.parse(ts) + BEIJING_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function money(n: number): string {
  const cur = vscode.workspace
    .getConfiguration("deepseekUsage")
    .get<Currency>("currency", "cny");
  const rate =
    getLiveRate() ??
    vscode.workspace.getConfiguration("deepseekUsage").get<number>("cnyPerUsd", 7.0);
  return fmtMoney(n, cur, rate);
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

function chartHtml(
  buckets: { label: string; cost: number; tokens: number }[],
  kind: ChartKind,
): string {
  if (buckets.length === 0) {
    return `<div class="muted">${t("noRequestsToday")}</div>`;
  }
  const vals = buckets.map((b) => (kind === "cost" ? b.cost : b.tokens));
  const max = Math.max(1, ...vals);
  const fmt = (n: number) => (kind === "cost" ? money(n) : fmtNum(n));
  const barW = Math.max(360 / buckets.length, 10);
  const step = Math.max(1, Math.ceil(buckets.length / 32));
  const bars = buckets
    .map((b, i) => {
      const v = kind === "cost" ? b.cost : b.tokens;
      const h = Math.round((v / max) * 100);
      return `<div class="bar-col" style="width:${barW}px" title="${b.label}: ${fmt(v)}">
        <div class="bar" style="height:${h}%"></div>
        <div class="bl">${i % step === 0 ? b.label : ""}</div>
      </div>`;
    })
    .join("");
  return `<div class="chart">${bars}</div>`;
}

function render(
  data: DetailData,
  range: RangeKey,
  kind: ChartKind,
): string {
  const s = data;
  const today = new Date(Date.now() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
  const peakBadge = data.peakNow
    ? `<span class="badge peak">${t("peakBadge")}</span>`
    : `<span class="badge off">${t("offpeakBadge")}</span>`;

  const rangeBtn = (k: RangeKey) =>
    `<button class="seg${k === range ? " active" : ""}" data-range="${k}">${t(
      "range" + k[0].toUpperCase() + k.slice(1),
    )}</button>`;
  const kindBtn = (k: ChartKind) =>
    `<button class="seg${k === kind ? " active" : ""}" data-kind="${k}">${
      k === "cost" ? t("chartCost") : t("chartTokens")
    }</button>`;

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
  .chart { display: flex; align-items: flex-end; gap: 2px; height: 140px; overflow-x: auto; padding-bottom: 18px; }
  .bar-col { display: flex; flex-direction: column; justify-content: flex-end; height: 100%; min-width: 8px; }
  .bar { background: var(--vscode-charts-blue); border-radius: 2px 2px 0 0; width: 100%; }
  .bl { font-size: 9px; opacity: .7; text-align: center; margin-top: 2px; white-space: nowrap; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  th { opacity: .7; font-weight: 500; }
  td.num, th.num { text-align: right; font-family: var(--vscode-editor-font-family); }
  .err { color: #ff6b6b; }
  .muted { opacity: .7; font-size: 11px; }
</style>
</head>
<body data-range="${range}">
  <h1>${t("panelTitle")} <span class="muted">${today}</span> ${peakBadge}
    <span class="spacer"></span>
    <button class="btn" id="export">${t("exportCsv")}</button>
  </h1>

  <div class="toolbar">
    ${RANGE_KEYS.map(rangeBtn).join("")}
    <span class="spacer"></span>
    ${kindBtn("cost")}
    ${kindBtn("tokens")}
  </div>

  <h2>${t("byTime")}</h2>
  ${chartHtml(s.buckets, kind)}

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
  <script>
    const vscode = acquireVsCodeApi();
    setInterval(() => vscode.postMessage({ type: "refresh" }), 5000);
    document.querySelectorAll(".seg[data-range]").forEach((b) =>
      b.addEventListener("click", () => vscode.postMessage({ type: "range", range: b.dataset.range })));
    document.querySelectorAll(".seg[data-kind]").forEach((b) =>
      b.addEventListener("click", () => vscode.postMessage({ type: "chart", kind: b.dataset.kind })));
    document.getElementById("export").addEventListener("click", () =>
      vscode.postMessage({ type: "exportCsv", range: document.body.dataset.range }));
  </script>
</body>
</html>`;
}

async function exportCsv(
  getData: (range: RangeKey) => DetailData,
  range: RangeKey,
) {
  const data = getData(range);
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

export function openDetailPanel(getData: (range: RangeKey) => DetailData): void {
  const panel = vscode.window.createWebviewPanel(
    "deepseekUsage.detail",
    t("panelTitle"),
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  let range: RangeKey = "today";
  let kind: ChartKind = "cost";
  const refresh = () => {
    panel.webview.html = render(getData(range), range, kind);
  };
  refresh();
  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === "range" && RANGE_KEYS.includes(msg.range as RangeKey)) {
      range = msg.range as RangeKey;
      refresh();
    } else if (msg.type === "chart") {
      kind = msg.kind === "tokens" ? "tokens" : "cost";
      refresh();
    } else if (msg.type === "exportCsv") {
      void exportCsv(getData, range);
    } else if (msg.type === "refresh") {
      refresh();
    }
  });
}
