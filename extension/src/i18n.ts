// 轻量 i18n：运行时字符串按语言切换。英文默认；中文系统（或 deepseekUsage.language 指定）用中文。
import * as vscode from "vscode";

export type Lang = "en" | "zh-cn";

const dict: Record<string, { en: string; zh: string }> = {
  todayBeijing: { en: "Today (Beijing time)", zh: "今天（北京时间）" },
  cost: { en: "Cost", zh: "费用" },
  cacheCost: { en: "Cache cost", zh: "缓存费用" },
  cacheHit: { en: "Cache hit", zh: "缓存命中" },
  totalToken: { en: "Total tokens", zh: "总token" },
  cacheToken: { en: "Cached tokens", zh: "缓存token" },
  input: { en: "Input", zh: "输入" },
  output: { en: "Output", zh: "输出" },
  proxy: { en: "Proxy", zh: "代理" },
  proxyRunning: { en: "running", zh: "运行中" },
  proxyStopped: { en: "not running", zh: "未运行" },
  clickForDetails: { en: "Click to view today's details", zh: "点此查看今日明细" },
  proxyAlreadyRunning: {
    en: "DeepSeek Usage proxy is already running",
    zh: "DeepSeek Usage 代理已在运行",
  },
  portInUseLog: {
    en: "Port {port} is in use; reusing the existing service. If it's not this extension's proxy, chats won't be logged and the status bar won't update.",
    zh: "端口 {port} 已被占用，复用现有服务；若占用方不是本扩展代理，聊天不会落库、状态栏不会更新",
  },
  portInUseWarn: {
    en: "Port {port} is in use; reusing the existing service (see Output panel)",
    zh: "端口 {port} 已被占用，直接复用现有服务（详见输出面板）",
  },
  proxyStartLog: {
    en: "Starting proxy {serverJs} --port {port} --jsonl {jsonl}",
    zh: "启动代理 {serverJs} --port {port} --jsonl {jsonl}",
  },
  proxyExitLog: { en: "Proxy process exited code={code}", zh: "代理进程退出 code={code}" },
  proxyStoppedLog: { en: "Proxy stopped and baseUrl restored", zh: "已停止代理并恢复 baseUrl" },
  outputChannelName: { en: "DeepSeek Usage Proxy", zh: "DeepSeek Usage 代理" },
  panelTitle: { en: "DeepSeek Usage · Today's Details", zh: "DeepSeek Usage · 今日明细" },
  peakBadge: { en: "Peak ×2", zh: "高峰 ×2" },
  offpeakBadge: { en: "Off-peak", zh: "空闲" },
  byModel: { en: "By model", zh: "按模型" },
  recentRequests: { en: "Recent requests", zh: "最近请求" },
  model: { en: "Model", zh: "模型" },
  count: { en: "Count", zh: "次数" },
  time: { en: "Time", zh: "时间" },
  status: { en: "Status", zh: "状态" },
  error: { en: "Error", zh: "错误" },
  totalCache: { en: "Total/cache", zh: "总/缓存" },
  noRecordsToday: { en: "No records today", zh: "今天还没有记录" },
  noRequestsToday: { en: "No proxied requests today", zh: "今天还没有经代理的请求" },
  autoRefreshNote: {
    en: "Auto-refreshes every 5s · today's proxied requests only (Beijing time).",
    zh: "每 5 秒自动刷新 · 仅统计今天（北京时间）经代理的请求。",
  },
};

/** 当前语言：配置显式指定优先，否则跟随 VS Code 显示语言（非中文即英文）。 */
export function lang(): Lang {
  const c = vscode.workspace
    .getConfiguration("deepseekUsage")
    .get<string>("language", "auto");
  if (c === "en" || c === "zh-cn") return c;
  return vscode.env.language.toLowerCase().startsWith("zh") ? "zh-cn" : "en";
}

export function isZh(): boolean {
  return lang() === "zh-cn";
}

/** 取翻译；{name} 占位符由 vars 替换。 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const e = dict[key];
  if (!e) return key;
  let s = isZh() ? e.zh : e.en;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return s;
}
