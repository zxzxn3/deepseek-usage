// 明细面板（Webview）：今日汇总卡 + 按模型分表 + 最近请求。
// 只读快照，每 5 秒自动刷新；数据由扩展侧 getData 回调提供。
import * as vscode from "vscode";
import { TodayStats, ModelStats, beijingDayStartUtcMs } from "./stats";
import { UsageRecord } from "./jsonl";
import { costFromUsage, isPeakBeijing } from "./pricing";
import { fmtNum } from "./server/termfmt";
import { t } from "./i18n";

export interface ModelRow {
  name: string;
  m: ModelStats;
}

export interface DetailData {
  stats: TodayStats;
  models: ModelRow[];
  recent: UsageRecord[];
  peakNow: boolean;
}

const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

function beijingTime(ts: string): string {
  const d = new Date(Date.parse(ts) + BEIJING_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function money(n: number): string {
  return `￥${n.toFixed(4)}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function recCost(r: UsageRecord): number {
  const peak = isPeakBeijing(new Date(Date.parse(r.ts)));
  return costFromUsage(
    r.prompt_tokens ?? 0,
    r.completion_tokens ?? 0,
    r.cache_hit_tokens ?? 0,
    r.cache_miss_tokens ?? 0,
    r.model,
    peak,
  );
}

function render(data: DetailData): string {
  const s = data.stats;
  const today = new Date(Date.now() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
  const peakBadge = data.peakNow
    ? `<span class="badge peak">${t("peakBadge")}</span>`
    : `<span class="badge off">${t("offpeakBadge")}</span>`;

  const card = (k: string, v: string) =>
    `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`;

  const summary =
    card(t("cost"), money(s.cost)) +
    card(t("cacheCost"), money(s.chCost)) +
    card(t("totalToken"), fmtNum(s.t)) +
    card(t("cacheToken"), fmtNum(s.ch)) +
    card(t("input"), fmtNum(s.p)) +
    card(t("output"), fmtNum(s.c));

  const modelRows =
    data.models.length === 0
      ? `<tr><td colspan="7" class="muted">${t("noRecordsToday")}</td></tr>`
      : data.models
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

  const todayStart = beijingDayStartUtcMs(new Date());
  const recent = data.recent
    .filter(
      (r) => Number.isFinite(Date.parse(r.ts)) && Date.parse(r.ts) >= todayStart,
    )
    .slice(-30)
    .reverse();
  const recentRows =
    recent.length === 0
      ? `<tr><td colspan="7" class="muted">${t("noRequestsToday")}</td></tr>`
      : recent
          .map((r) => {
            const err = r.error
              ? `<span class="err">✗ ${esc(r.error.slice(0, 60))}</span>`
              : "";
            const mode = r.stream ? "s" : "o";
            return `<tr>
        <td class="num">${beijingTime(r.ts)}</td>
        <td>${esc(r.model)}</td>
        <td class="num">${fmtNum(r.prompt_tokens)}/${fmtNum(r.completion_tokens)}</td>
        <td class="num">${fmtNum(r.total_tokens)}/${fmtNum(r.cache_hit_tokens)}</td>
        <td class="num">${money(recCost(r))}</td>
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
  h1 { font-size: 15px; margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
  h2 { font-size: 13px; margin: 18px 0 6px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; }
  .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px 12px; min-width: 118px; }
  .card .k { font-size: 11px; opacity: .8; }
  .card .v { font-size: 15px; font-weight: 600; margin-top: 2px; font-family: var(--vscode-editor-font-family); }
  .badge { font-size: 11px; padding: 1px 8px; border-radius: 9px; }
  .badge.peak { background: rgba(255,90,90,.18); color: #ff6b6b; }
  .badge.off { background: rgba(80,220,140,.16); color: #3fce6b; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  th { opacity: .7; font-weight: 500; }
  td.num, th.num { text-align: right; font-family: var(--vscode-editor-font-family); }
  .err { color: #ff6b6b; }
  .muted { opacity: .7; font-size: 11px; }
</style>
</head>
<body>
  <h1>${t("panelTitle")} <span class="muted">${today}</span> ${peakBadge}</h1>
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
  </script>
</body>
</html>`;
}

export function openDetailPanel(getData: () => DetailData): void {
  const panel = vscode.window.createWebviewPanel(
    "deepseekUsage.detail",
    t("panelTitle"),
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  const refresh = () => {
    panel.webview.html = render(getData());
  };
  refresh();
  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === "refresh") refresh();
  });
}
