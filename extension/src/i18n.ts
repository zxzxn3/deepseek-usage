// UI strings dictionary. Language follows the VS Code display language
// (Chinese interface → Chinese, otherwise English).
// Manual translation: edit the `zh` values below to refine the Chinese strings.
import * as vscode from "vscode";

export type Lang = "en" | "zh-cn";

const dict: Record<string, { en: string; zh: string }> = {
  todayBeijing: { en: "Today (Beijing time)", zh: "今天（北京时间）" },
  cost: { en: "Cost", zh: "费用" },
  cacheCost: { en: "Cache cost", zh: "缓存费用" },
  cacheHit: { en: "Cache hit", zh: "缓存命中" },
  totalToken: { en: "Total tokens", zh: "总词元" },
  cacheToken: { en: "Cached tokens", zh: "缓存词元" },
  input: { en: "Prompt", zh: "Prompt" },
  output: { en: "Completion", zh: "Completion" },
  proxy: { en: "Proxy", zh: "代理" },
  proxyRunning: { en: "running", zh: "运行中" },
  proxyStopped: { en: "not running", zh: "未运行" },
  clickForDetails: { en: "Click to switch format / view details", zh: "点击切换格式 / 查看明细" },
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
  peakBadge: { en: "Peak(×2)", zh: "高峰（×2）" },
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
  statusFormatTitle: { en: "Status bar display format", zh: "状态栏显示格式" },
  statusFormatFull: { en: "Full · cost + tokens", zh: "完整 · 费用 + 词元" },
  statusFormatCost: { en: "Cost only", zh: "仅费用" },
  statusFormatTokens: { en: "Tokens only", zh: "仅词元" },
  statusFormatTotalT: { en: "Total tokens", zh: "总词元" },
  statusFormatTotalCost: { en: "Total cost", zh: "总费用" },
  openDetails: { en: "Open today's details", zh: "查看今日明细" },
  rangeToday: { en: "Today", zh: "今天" },
  rangeWeek: { en: "Week", zh: "周" },
  rangeMonth: { en: "Month", zh: "月" },
  rangeAll: { en: "All", zh: "全部" },
  byTime: { en: "Usage over time", zh: "按时间" },
  chartCost: { en: "Cost", zh: "费用" },
  chartTokens: { en: "Tokens", zh: "词元" },
  exportCsv: { en: "Export CSV", zh: "导出 CSV" },
  exportDone: { en: "Exported {n} rows → {path}", zh: "已导出 {n} 行 → {path}" },
  requests: { en: "Requests", zh: "请求数" },
};

/** Language follows the VS Code display language (Chinese interface → Chinese, otherwise English). */
export function lang(): Lang {
  return vscode.env.language.toLowerCase().startsWith("zh") ? "zh-cn" : "en";
}

export function isZh(): boolean {
  return lang() === "zh-cn";
}

/** Look up a UI string; {name} placeholders are replaced by vars. */
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
