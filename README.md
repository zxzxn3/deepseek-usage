# DeepSeek token 用量记录（两路拆分）

你在 **VS Code Copilot Chat**（通过 `Vizards/deepseek-v4-for-copilot` 扩展）里用 **DeepSeek API**。
本项目用**两条独立路线**记录 token 消耗，外加一个**共用定价模块**：

```
token_usage/
  common/           共用：官方定价表 + 费用计算（两条路共用）
  path1_transcript/ 路1（估算）：读本地转录 → tokenizer 数 token → 估算费用 → usage_sessions.db
  path2_api/        路2（精确）：拦截真实请求 → 把响应里的 usage → usage.db
```

## 两条路对比

| | 路1 `path1_transcript/scan.py` | 路2 `path2_api/proxy.py` |
| --- | --- | --- |
| 数据来源 | 读本地 Copilot 转录（事后） | 拦截/手动发真实请求（在线） |
| 精度 | 分词精确，但**总量偏低**（事件≠请求） | **精确**（每请求真实 usage） |
| 覆盖 | 全部历史会话 | 只覆盖启用代理之后的请求 |
| 数据库 | `path1_transcript/usage_sessions.db` | `path2_api/usage.db` |
| 是否需要 key | 否 | 是（`DEEPSEEK_API_KEY`） |

## 依赖

- Python 3.10+（本项目 `.venv` 已是 3.12）
- `tokenizers`（路1 精确计数，已装）
- `tiktoken`（OpenAI 系计数，可选，已装）
- 其余全部**标准库**

## 路1：转录估算（不需要 key）

```powershell
# 扫描全部工作区 → 写 usage_sessions.db（增量：只重算变化的会话）
& d:\Flow-1.5\.venv\Scripts\python.exe path1_transcript\scan.py
# 监听模式（每 N 秒更新一行摘要）
& d:\Flow-1.5\.venv\Scripts\python.exe path1_transcript\scan.py --watch 5
# 调试单文件 / 单文本
& d:\Flow-1.5\.venv\Scripts\python.exe path1_transcript\measure.py <transcript.jsonl> --turns 8 --ctx 5
& d:\Flow-1.5\.venv\Scripts\python.exe path1_transcript\measure.py --text "你的文本"
```

- 多工作区自动识别（不写死用户名）；schema 版本变了才重建库，稳定后增量更新。
- 费用用 `common/pricing.py`（`--pricing auto` 按事件时间自动分高峰/空闲）。

## 路2：真实 usage（需要 key）

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."          # 在终端设置，别发 AI

# 验证 + 记录一次
& d:\Flow-1.5\.venv\Scripts\python.exe path2_api\proxy.py check --prompt "hi"

# 启动拦截代理（事件触发式：来请求才记账）
& d:\Flow-1.5\.venv\Scripts\python.exe path2_api\proxy.py proxy --port 8080

# 查看记录
& d:\Flow-1.5\.venv\Scripts\python.exe path2_api\proxy.py list --limit 20
```

**接入 Copilot**：把扩展的 `baseUrl` 指向代理，则每次真实聊天请求都会落库：
```json
"deepseek-copilot.baseUrl": "http://127.0.0.1:8080"
```

### 代理终端输出（表头 + 分隔 + 表格行 + 底部统计栏）

启动时打印表头与分隔行（并在横幅里说明模型一次）；每记录一次请求，追加一行；TTY 下最后一行是**底部统计栏**（随每次请求刷新）：

```
 时间       输入/输出    token总/缓存    费用总/缓存      状态
-------------------------------------------------------------------
03:37:42  111.4k/799  112.2k/109.8k  ￥0.0114/0.0055  s200
03:38:55  112.8k/2.2k  115.0k/111.4k  ￥0.0176/0.0056  s200
```

底部统计栏（当天累计，本地时区，与行同格式）：

```
2026-08-24 | 输入/输出 33.41M/133.9k token总/缓存 33.55M/33.30M 费用 ￥2.7825/1.5870
```

| 字段 | 含义 |
| --- | --- |
| `输入/输出` | p/c：prompt / completion tokens（`111.4k/799` = 输入 111.4k、输出 799） |
| `token总/缓存` | t/cH：总 token / 缓存命中 token（`112.2k/109.8k`） |
| `费用总/缓存` | ￥本次总费用 / 缓存命中部分费用（`￥0.0114/0.0055`） |
| `s`/`o` + 状态码 | 流式 / 非流式 + HTTP 状态码 |
| — | 模型在启动横幅说明一次（透传客户端请求，默认 `deepseek-v4-flash`），行内省略 |

- token 数缩写：`<1000` 原样、`<1M` 一位小数 k、以上两位小数 M。
- 费用取 4 位小数；统计栏与各行相加的 ±0.1k 视觉差属正常（行各自舍入、统计栏对精确值只舍一次）。
- 非 TTY（重定向/管道）时自动退化为纯追加，不打 ANSI。
- 费用用 `common/pricing` 按空闲价计算；缓存命中率越高越省钱。

## common/pricing.py（共用）

- `PRICING`：官方定价表（2026-08，含缓存命中/未命中/输出）
- `cost_from_roles`：路1 用（角色→输入/输出估算）
- `cost_from_usage`：路2 用（精确 usage 计费）

## 说明

- 报告/图表暂时移除，专注打磨两条管线；后续需要时再加。
- 权威精确值始终以 **platform.deepseek.com 仪表板**为准。

