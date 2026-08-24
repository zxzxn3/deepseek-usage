// rate.ts — USD→CNY 汇率：优先从免费公开 API 拉取，失败由调用方回退配置值。
// 纯模块（不依赖 vscode），扩展宿主内扩展与明细面板共用。
const API_LIST: { url: string; parse: (j: any) => number | null }[] = [
  {
    url: "https://open.er-api.com/v6/latest/USD",
    parse: (j) =>
      j && j.result === "success" && typeof j.rates?.CNY === "number"
        ? j.rates.CNY
        : null,
  },
  {
    url: "https://api.frankfurter.app/latest?from=USD&to=CNY",
    parse: (j) =>
      j && typeof j.rates?.CNY === "number" ? j.rates.CNY : null,
  },
];

let liveRate: number | null = null;

export function getLiveRate(): number | null {
  return liveRate;
}

export function setLiveRate(rate: number | null): void {
  liveRate = rate;
}

/** 依次尝试公开 API，返回 CNY/USD 汇率；全部失败返回 null（调用方回退配置值）。 */
export async function fetchCnyPerUsd(timeoutMs = 8000): Promise<number | null> {
  for (const api of API_LIST) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(api.url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const rate = api.parse(await res.json());
      if (rate && rate > 0) {
        setLiveRate(rate);
        return rate;
      }
    } catch {
      // 网络/解析失败：试下一个
    }
  }
  return null;
}
