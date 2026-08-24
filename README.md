# DeepSeek Usage

在 VS Code Copilot Chat（通过 `Vizards/deepseek-v4-for-copilot` 扩展）里使用 DeepSeek API 时，用本地代理拦截真实请求，实时统计今日费用与 token 用量。

- **状态栏**：实时显示费用 / 缓存费用 + 总 token / 缓存 token（北京时间，含高峰 ×2），点击可切换显示格式
- **明细面板**：区间（今天 / 周 / 月 / 全部）汇总、按时间柱状图（今天按小时）、按模型分表、最近请求、导出 CSV
- **代理**：本地 OpenAI 兼容代理，真流式透传（chunked / SSE / 断连续读）；`autoStart` 自动接管 `deepseek-copilot.baseUrl`，停止时恢复
- **可配置**：定价覆盖、货币（cny / usd，汇率自动拉取）、状态栏格式、轮询间隔、界面语言（跟随 VS Code）

## 目录

- 本仓库即 VS Code 扩展（TypeScript + esbuild，运行时零依赖）
- 数据存于 VS Code 全局存储的 `usage.jsonl`：一行一次请求，只存原始事实（UTC 时间戳 + tokens），费用在展示层按定价现算

## 构建与调试

```powershell
npm install
npm run compile     # 或 npm run watch（开发热重建）
npm run typecheck   # 类型检查
npm run smoke       # 测试
```

F5 打开扩展开发宿主调试；打包 + 安装 / 重装：

```powershell
# 打包（产物 deepseek-usage-*.vsix 生成在仓库根目录）
powershell -ExecutionPolicy Bypass -File .\package.ps1

# 安装 / 重装（--force 覆盖同版本；不加会因"版本相同"被拒绝）
code --install-extension .\deepseek-usage-0.1.0.vsix --force
```

## 配置（settings.json）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `deepseekUsage.port` | `8080` | 代理监听端口 |
| `deepseekUsage.autoStart` | `true` | VS Code 启动自动拉起代理 |
| `deepseekUsage.manageBaseUrl` | `true` | 代理运行时自动接管/停止时恢复 `deepseek-copilot.baseUrl` |
| `deepseekUsage.pollIntervalSeconds` | `10` | 状态栏刷新间隔（秒，下限 2） |
| `deepseekUsage.statusBarFormat` | `full` | 状态栏格式：`full`/`cost`/`tokens`/`totalT`/`totalCost` |
| `deepseekUsage.pricing` | `{}` | 按模型定价覆盖（元 / 百万 token）：`{"deepseek-v4-flash": {"cache_hit":0.05,"cache_miss":1.5,"output":4.5}}` |
| `deepseekUsage.currency` | `cny` | 费用货币：`cny`（￥）/ `usd`（$） |
| `deepseekUsage.cnyPerUsd` | `6.74` | 汇率兜底值（自动从公开 API 拉取失败时用） |

定价说明：内置默认价 + 用户覆盖；高峰价 = 非高峰 ×2（北京时间周一~五 9-12、14-18）；美元显示用实时汇率，拉不到才用 `cnyPerUsd`。

## 命令

- `DeepSeek Usage: Today's Details` — 打开今日明细面板
- `DeepSeek Usage: Toggle Proxy` — 启动 / 停止代理（命令面板按运行状态动态显示）
- `DeepSeek Usage: Status Bar Format` — 状态栏格式选择

## 图标

图标 `icon.png` 放在仓库根目录，`package.json` 的 `"icon"` 字段已指向它，`vsce package` 会打进 vsix。

图标制作参考图源：
- [DeepSeek icon by Icons8](https://icons8.com/icon/YWOidjGxCpFW/deepseek)
- [Pinterest](https://pin.it/1VinTVnmY)

## License

MIT
