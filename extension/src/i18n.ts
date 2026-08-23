// UI strings live here; English is the primary language.
// If multilingual support is needed later, extend this map with more locales.
const dict: Record<string, string> = {
  todayBeijing: "Today (Beijing time)",
  cost: "Cost",
  cacheCost: "Cache cost",
  cacheHit: "Cache hit",
  totalToken: "Total tokens",
  cacheToken: "Cached tokens",
  input: "Input",
  output: "Output",
  proxy: "Proxy",
  proxyRunning: "running",
  proxyStopped: "not running",
  clickForDetails: "Click to view today's details",
  proxyAlreadyRunning: "DeepSeek Usage proxy is already running",
  portInUseLog: "Port {port} is in use; reusing the existing service. If it's not this extension's proxy, chats won't be logged and the status bar won't update.",
  portInUseWarn: "Port {port} is in use; reusing the existing service (see Output panel)",
  proxyStartLog: "Starting proxy {serverJs} --port {port} --jsonl {jsonl}",
  proxyExitLog: "Proxy process exited code={code}",
  proxyStoppedLog: "Proxy stopped and baseUrl restored",
  outputChannelName: "DeepSeek Usage Proxy",
  panelTitle: "DeepSeek Usage · Today's Details",
  peakBadge: "Peak ×2",
  offpeakBadge: "Off-peak",
  byModel: "By model",
  recentRequests: "Recent requests",
  model: "Model",
  count: "Count",
  time: "Time",
  status: "Status",
  error: "Error",
  totalCache: "Total/cache",
  noRecordsToday: "No records today",
  noRequestsToday: "No proxied requests today",
  autoRefreshNote: "Auto-refreshes every 5s · today's proxied requests only (Beijing time).",
};

/** Look up a UI string; {name} placeholders are replaced by vars. */
export function t(key: string, vars?: Record<string, string | number>): string {
  let s = dict[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return s;
}
