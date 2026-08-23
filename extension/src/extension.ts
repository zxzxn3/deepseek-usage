// DeepSeek Usage 扩展入口。
// 职责：状态栏显示今日费用/token（北京时间）· 管理代理子进程 · 可选接管 Copilot baseUrl。
import * as vscode from "vscode";
import * as cp from "child_process";
import * as net from "net";
import * as path from "path";
import * as fs from "fs";
import { TailReader } from "./jsonl";
import { TodayStats, newTodayStats, addRecord, beijingDayStartUtcMs } from "./stats";

let statusBar: vscode.StatusBarItem;
let jsonlPath = "";
let tailReader: TailReader | null = null;
let stats: TodayStats = newTodayStats();
let lastDayStart = 0;
let timer: NodeJS.Timeout | null = null;
let proxyProc: cp.ChildProcess | null = null;
let originalBaseUrl: string | undefined;

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
    vscode.commands.registerCommand("deepseekUsage.refresh", () => poll()),
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
    lastDayStart = dayStart;
  }
  for (const rec of tailReader.readNew()) addRecord(stats, rec);
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
    `今天（北京时间）\n\n` +
      `费用 ￥${s.cost.toFixed(4)} / 缓存命中 ￥${s.chCost.toFixed(4)}\n` +
      `总token ${fmtTok(s.t)} / 缓存命中 ${fmtTok(s.ch)}\n` +
      `输入 ${fmtTok(s.p)} / 输出 ${fmtTok(s.c)}\n\n` +
      `代理：${running ? "运行中" : "未运行"}\n` +
      `点此查看明细（占位）`,
  );
  statusBar.tooltip.supportHtml = false;
}

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

async function showStats() {
  const s = stats;
  const items: vscode.QuickPickItem[] = [
    { label: `费用 ￥${s.cost.toFixed(4)} / 缓存 ￥${s.chCost.toFixed(4)}`, description: "今天（北京时间）" },
    { label: `总token ${fmtTok(s.t)} / 缓存 ${fmtTok(s.ch)}`, description: "输入输出 ${fmtTok(s.p)}/${fmtTok(s.c)}" },
  ];
  await vscode.window.showQuickPick(items, {
    placeHolder: "DeepSeek Usage 今日明细（占位，后续做 Webview）",
  });
}

async function startProxy(context: vscode.ExtensionContext) {
  if (proxyProc && !proxyProc.killed) {
    void vscode.window.showInformationMessage("DeepSeek Usage 代理已在运行");
    return;
  }
  const port = getCfg().get<number>("port", 8080);

  // 端口探测：已被占用 → 复用现有服务
  if (await isPortInUse(port)) {
    void vscode.window.showWarningMessage(
      `端口 ${port} 已被占用，直接复用现有服务`,
    );
  } else {
    const serverJs = path.join(context.extensionUri.fsPath, "out", "server.js");
    proxyProc = cp.spawn(
      process.execPath,
      [serverJs, "--port", String(port), "--jsonl", jsonlPath],
      { stdio: "ignore" }, // R5：之后可改 OutputChannel 看日志
    );
    proxyProc.on("exit", () => {
      proxyProc = null;
      renderStatusBar();
    });
  }

  if (getCfg().get<boolean>("manageBaseUrl", true)) {
    takeOverBaseUrl(port);
  }
  renderStatusBar();
}

function stopProxy() {
  if (proxyProc && !proxyProc.killed) {
    proxyProc.kill();
  }
  proxyProc = null;
  restoreBaseUrl();
  renderStatusBar();
}

function takeOverBaseUrl(port: number) {
  const cfg = vscode.workspace.getConfiguration("deepseek-copilot");
  originalBaseUrl = cfg.get<string>("baseUrl");
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
