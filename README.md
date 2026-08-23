# DeepSeek token 用量记录工具

通过 **DeepSeek API**（`api.deepseek.com`，OpenAI 兼容）获取**真实 token 用量**（`usage` 对象），落库 + 画图。

> 为什么需要它：你的设置是直连 **DeepSeek API**（不是 GitHub Copilot——你没买 Copilot 订阅）。DeepSeek 每次响应都带 `usage`（含 prompt/completion/total，以及缓存的 cache_hit/cache_miss）。本工具在本地记录每一次调用的 usage 并可视化。
>
> 最简单的替代方案：登录 **platform.deepseek.com → Usage**，官方仪表板已有历史汇总。本工具适合你想要**每请求粒度 + 本地图表**时使用。

## 依赖

- Python 3.10+（本项目 `.venv` 已是 3.12）
- `matplotlib`（画图，已安装）
- `tokenizers`（转录精确计数，DeepSeek/任意 tokenizer.json，已安装）
- `tiktoken`（OpenAI 系 token 计数，已安装）
- 其余全部**标准库**（`http.server` / `urllib` / `sqlite3`）

## 凭据（重要）

读取环境变量 **`DEEPSEEK_API_KEY`**（在 platform.deepseek.com 申请）。
**不要把 key 发给任何 AI** —— 直接在终端里设置：

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."    # 会话级，关掉终端即失效
```

## 用法

```powershell
# 1) 一次性验证 + 记录一次真实 usage（确认 key 可用）
& d:\Flow-1.5\.venv\Scripts\python.exe deepseek_usage.py check --model deepseek-v4-flash --prompt "hi"

# 2) 启动本地代理（把任意 OpenAI 兼容客户端指向这里，转发到 DeepSeek 并记录每次 usage）
& d:\Flow-1.5\.venv\Scripts\python.exe deepseek_usage.py proxy --port 8080
#    客户端 base_url 设为 http://127.0.0.1:8080/v1

# 3) 查看记录
& d:\Flow-1.5\.venv\Scripts\python.exe deepseek_usage.py list --limit 20

# 4) 汇总 + 生成每日 token 图（输出到 charts\usage_daily.png）
& d:\Flow-1.5\.venv\Scripts\python.exe deepseek_usage.py report
```

## 本地转录 token 统计（不需要 DeepSeek key）

用**真实 tokenizer** 精确统计 VS Code Copilot 聊天转录——所有轮次都留存在本地 `GitHub.copilot-chat\transcripts\*.jsonl`。默认**自动定位转录目录**（不写死用户名）；tokenizer 用 `--tokenizer` 指定：
- `tokenizer.json` 路径（任意 HuggingFace/tokenizers BPE 模型，DeepSeek 默认自动查找）
- tiktoken 编码名（OpenAI 系：`o200k_base` / `cl100k_base` 等）

```powershell
# 1) 更新持久化消耗表（扫描全部本地会话 → SQLite + 打印 token/费用汇总 + 图表）
& d:\Flow-1.5\.venv\Scripts\python.exe update_usage_table.py --chart
#    可选：指定计费模型 / 高峰价 / 换 tokenizer
& d:\Flow-1.5\.venv\Scripts\python.exe update_usage_table.py --chart --model deepseek-v4-flash --peak
& d:\Flow-1.5\.venv\Scripts\python.exe update_usage_table.py --tokenizer o200k_base

# 2) 精确统计单个转录：总数 + 最近轮次 + 每轮 user 消息时的累计上下文
& d:\Flow-1.5\.venv\Scripts\python.exe measure_transcript.py <transcript.jsonl> --turns 8 --ctx 5

# 3) 精确数任意文本（可指定 tokenizer）
& d:\Flow-1.5\.venv\Scripts\python.exe measure_transcript.py --text "你的文本" --tokenizer o200k_base
```

**费用估算**：按转录角色近似（user+tool≈输入、assistant≈输出）× 官方定价（`deepseek-v4-flash` / `-pro` / `-vision-exp`，空闲价；`--peak` 为高峰价=×2）。缓存命中与否未知，故给上下限：`费用↑`=无缓存（上限）、`费用↓`=全缓存命中（下限）。价格基于 2026-08 官方页面，需自行留意变更。

输出：`usage_sessions.db`（表 `session_usage`，每次运行重算并 upsert）、`charts\sessions_YYYYMMDD_HHMMSS.png`（**带时间戳，不覆盖旧图**）。

> 注意：这些是**转录正文**的精确 token 数；真实每请求还含注入上下文（系统提示/工具 schema/技能清单等），权威精确值以 platform.deepseek.com 仪表板为准。

## 模型

- `deepseek-v4-flash`（默认，V4 系列对话模型，价格最低）
- `deepseek-v4-pro`（更强，价格更高）
- `deepseek-v4-flash-vision-exp`（多模态实验版）
- 用 `--model` 指定；代理模式则透传请求体里的 `model` 字段。

## 输出文件

| 文件 | 说明 |
| --- | --- |
| `usage.db` | SQLite，表 `usage_log`（ts/model/prompt/completion/total/cache_hit/cache_miss/…） |
| `usage.jsonl` | 每行一条 JSON 记录，便于 grep |
| `charts\usage_daily.png` | 每日 prompt/completion 堆叠柱状图 + 合计折线 |

均已被 `.gitignore` 忽略，不会被提交。

## 注意

- `report` 只统计 `status=200` 且带 usage 的记录。
- 代理对超长流式输出会先缓存再转发（个人日志够用）。
- 本工具只记录**启用之后**经过它的请求；历史用量请直接看 platform.deepseek.com 仪表板。
