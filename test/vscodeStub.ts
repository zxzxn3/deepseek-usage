// 测试 vscode 替身（test 用）：只暴露被测模块用到的 API。
export const env = { language: "zh-cn" };
export const workspace = {
  getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
};
