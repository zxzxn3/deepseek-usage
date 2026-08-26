// currency.ts — 货币显示：内部统一按人民币(CNY)计费，显示时可转美元。
// 纯模块（不依赖 vscode），扩展与代理子进程共用。
export type Currency = "cny" | "usd";

/** 人民币成本 → 显示字符串（usd 时除以汇率并换符号）。 */
export function fmtMoney(
  costCny: number,
  currency: Currency,
  cnyPerUsd: number,
  digits = 4,
): string {
  const v = currency === "usd" ? costCny / cnyPerUsd : costCny;
  return `${currency === "usd" ? "$" : "￥"}${v.toFixed(digits)}`;
}

/** "总/缓存" 对，如 ￥1.2345/0.6789 或 $0.1764/0.0970。 */
export function moneyPair(
  costCny: number,
  chCostCny: number,
  currency: Currency,
  cnyPerUsd: number,
): string {
  return `${fmtMoney(costCny, currency, cnyPerUsd)}/${fmtMoney(
    chCostCny,
    currency,
    cnyPerUsd,
  )}`;
}
