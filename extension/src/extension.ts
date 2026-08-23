// DeepSeek Usage 扩展入口。
// 职责：状态栏显示今日费用/token（北京时间）· 管理代理子进程 · 可选接管 Copilot baseUrl。
import * as vscode from "vscode";
import * as cp from "child_process";
import * as net from "net";
import * as path from "path";
import * as fs from "fs";
import { TailReader, UsageRecord } from "./jsonl";
import {
  TodayStats,
  ModelStats,
  newTodayStats,
  newModelStats,
  addRecord,
  addModelRecord,
  beijingDayStartUtcMs,
} from "./stats";
import { isPeakBeijing } from "./pricing";
import { openDetailPanel } from "./detailPanel";
import { t, lang } from "./i18n";

let statusBar: vscode.StatusBarItem;
let jsonlPath = "";
let tailReader: TailReader | null = null;
let stats: TodayStats = newTodayStats();
let lastDayStart = 0;
let timer: NodeJS.Timeout | null = null;
let proxyProc: cp.ChildProcess | null = null;
let originalBaseUrl: string | undefined;
let proxyLog: vscode.OutputChannel | null = null;
let modelStats = new Map<string, ModelStats>(); // 按模型今日统计（明细面板用）
let recentRecs: UsageRecord[] = []; // 最近请求环形缓冲（明细面板用）
const RECENT_CAP = 60;

export function activate(context: vscode.ExtensionContext) {
  // 数据文件：扩展全局存储（用户级、跨工作区）
  jsonlPath = path.join(context.globalStorageUri.fsPath, "usage.jsonl");
  fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
  tailReader = new TailReader(jsonlPath);
  lastDayStart = beijingDayStartUtcMs(new Date());

  statusBar = vscode.window.createStatusBarItem(
    "deepseekUsage.cost",
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.name = "DeepSeek Usage";
  statusBar.command = "deepseekUsage.showStats";
  statusBar.show();

  context.subscriptions.push(
    vscode.commands.registerCommand("deepseekUsage.showStats", () => showStats()),
    vscode.commands.registerCommand("deepseekUsage.startProxy", () =>
      startProxy(context),
    ),
    vscode.commands.registerCommand("deepseekUsage.stopProxy", () => stopProxy()),
  );

  poll(); // 立即刷一次，并启动轮询
  setInterval(poll, 1000); // 每秒检查，按配置的 interval 触发实际刷新

  // R6：自动起代理；流式实现前 autoStart 默认 false
  if (getCfg().get<boolean>("autoStart", false)) {
    void startProxy(context);
  }
}

export function deactivate() {
  stopProxy(); // 恢复 baseUrl
}

function getCfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("deepseekUsage");
}

function poll() {
  if (!tailReader) return;
  const now = new Date();
  const dayStart = beijingDayStartUtcMs(now);
  if (dayStart !== lastDayStart) {
    // 北京日切换：重建当天聚合（重扫文件）
    tailReader.reset();
    stats = newTodayStats();
    modelStats = new Map();
    recentRecs = [];
    lastDayStart = dayStart;
  }
  for (const rec of tailReader.readNew()) {
    if (addRecord(stats, rec)) {
      let m = modelStats.get(rec.model);
      if (!m) {
        m = newModelStats();
        modelStats.set(rec.model, m);
      }
      addModelRecord(m, rec);
    }
    recentRecs.push(rec);
    if (recentRecs.length > RECENT_CAP) recentRecs.shift();
  }
  renderStatusBar();
}

function renderStatusBar() {
  if (!statusBar) return;
  const s = stats;
  const running = proxyProc !== null && !proxyProc.killed;
  if (s.t === 0 && s.cost === 0) {
    statusBar.text = `$(credit-card) ￥--/--  --/--`;
  } else {
    statusBar.text =
      `$(credit-card) ￥${s.cost.toFixed(4)}/${s.chCost.toFixed(4)}  ` +
      `${fmtTok(s.t)}/${fmtTok(s.ch)}`;
  }
  statusBar.tooltip = new vscode.MarkdownString(
    `${t("todayBeijing")}\n\n` +
      `${t("cost")} ￥${s.cost.toFixed(4)} / ${t("cacheHit")} ￥${s.chCost.toFixed(4)}\n` +
      `${t("totalToken")} ${fmtTok(s.t)} / ${t("cacheHit")} ${fmtTok(s.ch)}\n` +
      `${t("input")} ${fmtTok(s.p)} / ${t("output")} ${fmtTok(s.c)}\n\n` +
      `${t("proxy")}: ${running ? t("proxyRunning") : t("proxyStopped")}\n` +
      `${t("clickForDetails")}`,
  );
  statusBar.tooltip.supportHtml = false;
}

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

function showStats() {
  openDetailPanel(() => ({
    stats,
    models: [...modelStats.entries()].map(([name, m]) => ({ name, m })),
    recent: recentRecs,
    peakNow: isPeakBeijing(new Date()),
  }));
}

async function startProxy(context: vscode.ExtensionContext) {
  if (proxyProc && !proxyProc.killed) {
    void vscode.window.showInformationMessage(t("proxyAlreadyRunning"));
    return;
  }
  const port = getCfg().get<number>("port", 8080);
  const log = getProxyLog();

  // 端口探测：已被占用 → 复用现有服务（记日志，避免"看不见是谁在听"）
  if (await isPortInUse(port)) {
    log.appendLine(`[deepseek-usage] ${t("portInUseLog", { port })}`);
    void vscode.window.showWarningMessage(t("portInUseWarn", { port }));
  } else {
    const serverJs = path.join(context.extensionUri.fsPath, "out", "server.js");
    log.appendLine(
      `[deepseek-usage] ${t("proxyStartLog", { serverJs, port, jsonl: jsonlPath })}`,
    );
    proxyProc = cp.spawn(
      process.execPath,
      [serverJs, "--port", String(port), "--jsonl", jsonlPath, "--lang", lang()],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    proxyProc.stdout?.on("data", (d) => log.append(d.toString()));
    proxyProc.stderr?.on("data", (d) => log.append(d.toString()));
    proxyProc.on("exit", (code) => {
      log.appendLine(`[deepseek-usage] ${t("proxyExitLog", { code: String(code) })}`);
      proxyProc = null;
      renderStatusBar();
    });
  }

  if (getCfg().get<boolean>("manageBaseUrl", true)) {
    takeOverBaseUrl(port);
  }
  renderStatusBar();
}

function getProxyLog(): vscode.OutputChannel {
  if (!proxyLog) {
    proxyLog = vscode.window.createOutputChannel(t("outputChannelName"));
  }
  return proxyLog;
}

function stopProxy() {
  if (proxyProc && !proxyProc.killed) {
    proxyProc.kill();
  }
  proxyProc = null;
  restoreBaseUrl();
  getProxyLog().appendLine(`[deepseek-usage] ${t("proxyStoppedLog")}`);
  renderStatusBar();
}

function takeOverBaseUrl(port: number) {
  const cfg = vscode.workspace.getConfiguration("deepseek-copilot");
  // 只在首次接管时保存原值；重复调用不覆盖，保证 stopProxy 能正确恢复
  if (originalBaseUrl === undefined) {
    originalBaseUrl = cfg.get<string>("baseUrl");
  }
  void cfg.update(
    "baseUrl",
    `http://127.0.0.1:${port}`,
    vscode.ConfigurationTarget.Global,
  );
}

function restoreBaseUrl() {
  if (originalBaseUrl === undefined) return;
  const cfg = vscode.workspace.getConfiguration("deepseek-copilot");
  void cfg.update(
    "baseUrl",
    originalBaseUrl,
    vscode.ConfigurationTarget.Global,
  );
  originalBaseUrl = undefined;
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}
