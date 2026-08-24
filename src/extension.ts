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
  newTodayStats,
  addRecord,
  beijingDayStartUtcMs,
  aggregateRange,
  RangeKey,
} from "./stats";
import {
  isPeakBeijing,
  ModelPrice,
  applyOverrides,
  setPricingTable,
} from "./pricing";
import { Currency, fmtMoney, moneyPair } from "./currency";
import { fetchCnyPerUsd, getLiveRate } from "./rate";
import { openDetailPanel } from "./detailPanel";
import { t } from "./i18n";

let statusBar: vscode.StatusBarItem;
let jsonlPath = "";
let tailReader: TailReader | null = null;
let stats: TodayStats = newTodayStats();
let lastDayStart = 0;
let timer: NodeJS.Timeout | null = null;
let proxyProc: cp.ChildProcess | null = null;
let originalBaseUrl: string | undefined;
let proxyLog: vscode.OutputChannel | null = null;
let rateTimer: NodeJS.Timeout | null = null;

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
  statusBar.command = "deepseekUsage.statusBarFormat";
  statusBar.show();

  context.subscriptions.push(
    vscode.commands.registerCommand("deepseekUsage.showStats", () => showStats()),
    vscode.commands.registerCommand("deepseekUsage.toggleProxy", () =>
      toggleProxy(context),
    ),
    vscode.commands.registerCommand("deepseekUsage.statusBarFormat", () =>
      showStatusFormatMenu(),
    ),
  );
  applyPricingConfig(); // 应用用户定价覆盖
  void refreshRate(); // 启动即拉一次汇率（失败回退配置值）
  rateTimer = setInterval(() => void refreshRate(), 6 * 3600 * 1000); // 每 6 小时刷新
  updateProxyContext(); // 初始化命令面板里"启动/停止"的显示状态

  poll(); // 立即刷一次
  startPolling();
  // 轮询间隔配置变更时重建定时器
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("deepseekUsage.pollIntervalSeconds")) {
        startPolling();
      }
      if (e.affectsConfiguration("deepseekUsage.statusBarFormat")) {
        renderStatusBar();
      }
      if (e.affectsConfiguration("deepseekUsage.pricing")) {
        applyPricingConfig();
        resetAggregation();
        poll();
      }
      if (
        e.affectsConfiguration("deepseekUsage.currency") ||
        e.affectsConfiguration("deepseekUsage.cnyPerUsd")
      ) {
        renderStatusBar();
        if (getCurrency() === "usd") void refreshRate();
      }
    }),
  );

  // R6：自动起代理（流式已实现并验证，默认开启）
  if (getCfg().get<boolean>("autoStart", true)) {
    void startProxy(context);
  }
}

export function deactivate() {
  if (timer) clearInterval(timer); // 停用即停止轮询
  if (rateTimer) clearInterval(rateTimer); // 停用即停止汇率刷新
  stopProxy(); // 恢复 baseUrl
}

function getCfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("deepseekUsage");
}

type StatusFormat = "full" | "cost" | "tokens" | "totalT" | "totalCost";
function getStatusFormat(): StatusFormat {
  return getCfg().get<StatusFormat>("statusBarFormat", "full");
}

function getCurrency(): Currency {
  return getCfg().get<Currency>("currency", "cny");
}

function getCnyPerUsd(): number {
  return getLiveRate() ?? getCfg().get<number>("cnyPerUsd", 6.74);
}

/** 拉取实时汇率；成功后重渲染状态栏（金额可能变化）。 */
async function refreshRate() {
  const r = await fetchCnyPerUsd();
  if (r !== null) renderStatusBar();
}

/** 应用用户定价覆盖到生效表。 */
function applyPricingConfig() {
  const overrides = getCfg().get<Record<string, Partial<ModelPrice>>>(
    "pricing",
    {},
  );
  setPricingTable(applyOverrides(overrides));
}

/** 回到文件头并清空聚合（日切换 / 定价变更后重算）。 */
function resetAggregation() {
  if (!tailReader) return;
  tailReader.reset();
  stats = newTodayStats();
}

function pollIntervalMs(): number {
  const sec = getCfg().get<number>("pollIntervalSeconds", 10);
  return Math.max(2, sec) * 1000; // 下限 2s，与配置 minimum 一致
}

function startPolling() {
  if (timer) clearInterval(timer);
  timer = setInterval(poll, pollIntervalMs());
}

function poll() {
  if (!tailReader) return;
  const now = new Date();
  const dayStart = beijingDayStartUtcMs(now);
  if (dayStart !== lastDayStart) {
    // 北京日切换：重建当天聚合（重扫文件）
    resetAggregation();
    lastDayStart = dayStart;
  }
  for (const rec of tailReader.readNew()) addRecord(stats, rec);
  renderStatusBar();
}

function renderStatusBar() {
  if (!statusBar) return;
  const s = stats;
  const running = proxyProc !== null && !proxyProc.killed;
  const fmt = getStatusFormat();
  const cur = getCurrency();
  const rate = getCnyPerUsd();
  if (s.t === 0 && s.cost === 0) {
    statusBar.text = `$(credit-card) ${cur === "usd" ? "$" : "￥"}--/--  --/--`;
  } else {
    const costText = moneyPair(s.cost, s.chCost, cur, rate);
    const tokText = `${fmtTok(s.t)}/${fmtTok(s.ch)}`;
    if (fmt === "cost") {
      statusBar.text = `$(credit-card) ${costText}`;
    } else if (fmt === "tokens") {
      statusBar.text = `$(credit-card) ${tokText}`;
    } else if (fmt === "totalT") {
      statusBar.text = `$(credit-card) ${fmtTok(s.t)}`;
    } else if (fmt === "totalCost") {
      statusBar.text = `$(credit-card) ${fmtMoney(s.cost, cur, rate)}`;
    } else {
      statusBar.text = `$(credit-card) ${costText}  ${tokText}`;
    }
  }
  statusBar.tooltip = new vscode.MarkdownString(
    `${t("todayBeijing")}\n\n` +
      `${t("cost")} ${fmtMoney(s.cost, cur, rate)} / ${t("cacheHit")} ${fmtMoney(
        s.chCost,
        cur,
        rate,
      )}\n` +
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
  openDetailPanel((range) => {
    const all = readAllRecords();
    return { ...aggregateRange(all, range), peakNow: isPeakBeijing(new Date()) };
  });
}

/** 直接读整个 JSONL（明细面板按需全扫，独立于增量轮询）。 */
function readAllRecords(): UsageRecord[] {
  if (!fs.existsSync(jsonlPath)) return [];
  const out: UsageRecord[] = [];
  for (const line of fs.readFileSync(jsonlPath, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as UsageRecord);
    } catch {
      // 单行损坏则跳过
    }
  }
  return out;
}

/** 状态栏点击：选择显示格式（附今日明细入口），选择持久化到配置。 */
async function showStatusFormatMenu() {
  const current = getStatusFormat();
  const check = (f: StatusFormat) => (current === f ? "$(check) " : "");
  const choices: { id: StatusFormat | "details"; label: string; desc: string }[] = [
    { id: "full", label: `${check("full")}${t("statusFormatFull")}`, desc: "cost/chCost  totalT/cacheT" },
    { id: "cost", label: `${check("cost")}${t("statusFormatCost")}`, desc: "cost/chCost" },
    { id: "tokens", label: `${check("tokens")}${t("statusFormatTokens")}`, desc: "totalT/cacheT" },
    { id: "totalT", label: `${check("totalT")}${t("statusFormatTotalT")}`, desc: "totalT" },
    { id: "totalCost", label: `${check("totalCost")}${t("statusFormatTotalCost")}`, desc: "cost" },
    { id: "details", label: `$(list-unordered) ${t("openDetails")}`, desc: "" },
  ];
  const picked = await vscode.window.showQuickPick(
    choices.map((c) => ({ label: c.label, description: c.desc })),
    { placeHolder: t("statusFormatTitle") },
  );
  const chosen = choices.find((c) => c.label === picked?.label);
  if (!chosen) return;
  if (chosen.id === "details") {
    showStats();
    return;
  }
  await getCfg().update(
    "statusBarFormat",
    chosen.id,
    vscode.ConfigurationTarget.Global,
  );
  renderStatusBar();
}

/** 切换代理：运行中则停止，否则启动。 */
function toggleProxy(context: vscode.ExtensionContext) {
  if (proxyProc && !proxyProc.killed) {
    stopProxy();
  } else {
    void startProxy(context);
  }
}

/** 同步命令面板的 when 上下文（deepseekUsage.proxyRunning）。 */
function updateProxyContext() {
  void vscode.commands.executeCommand(
    "setContext",
    "deepseekUsage.proxyRunning",
    proxyProc !== null && !proxyProc.killed,
  );
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
    const pricingJson = JSON.stringify(getCfg().get<object>("pricing", {}));
    proxyProc = cp.spawn(
      process.execPath,
      [
        serverJs,
        "--port",
        String(port),
        "--jsonl",
        jsonlPath,
        "--pricing",
        pricingJson,
        "--currency",
        getCurrency(),
        "--rate",
        String(getCnyPerUsd()),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    proxyProc.stdout?.on("data", (d) => log.append(d.toString()));
    proxyProc.stderr?.on("data", (d) => log.append(d.toString()));
    proxyProc.on("exit", (code) => {
      log.appendLine(`[deepseek-usage] ${t("proxyExitLog", { code: String(code) })}`);
      proxyProc = null;
      updateProxyContext();
      renderStatusBar();
    });
  }

  if (getCfg().get<boolean>("manageBaseUrl", true)) {
    takeOverBaseUrl(port);
  }
  updateProxyContext();
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
  if (proxyLog) {
    proxyLog.appendLine(`[deepseek-usage] ${t("proxyStoppedLog")}`);
  }
  updateProxyContext();
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
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1500, () => done(false)); // 超时/黑洞按未占用处理
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}
