#!/usr/bin/env python3
"""path2/proxy.py — 路2（精确）：拦截真实请求，把响应里的 usage 存进 usage.db。

DeepSeek 的 API 是 OpenAI 兼容的：每次响应都带 usage 对象（prompt_tokens /
completion_tokens / total_tokens，以及缓存相关的 prompt_cache_hit_tokens /
prompt_cache_miss_tokens）。本工具做三件事：

  check   一次性调用 DeepSeek API，打印并记录一次真实 usage（验证 key 可用）
  proxy   本地 OpenAI 兼容代理：把请求转发给 DeepSeek API，并记录每次 usage
  list    打印最近 N 条记录

接入方式：把 Copilot 扩展（deepseek-v4-for-copilot）的 baseUrl 指向本代理，
例如 "deepseek-copilot.baseUrl": "http://127.0.0.1:8080"，则每次真实聊天
请求都会经过这里，usage 自动落库。

凭据
----
读取环境变量 DEEPSEEK_API_KEY。
不要把你的 key 发给任何 AI —— 直接在终端里设置并运行即可。

用法示例
--------
    $env:DEEPSEEK_API_KEY = "sk-..."          # 在终端里设置，别在聊天里发
    python proxy.py check --model deepseek-v4-flash --prompt "hi"
    python proxy.py proxy --port 8080
    python proxy.py list --limit 20
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import threading
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# 允许直接运行：把 token_usage 根加入 sys.path 以导入 common.pricing
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common.pricing import PRICING, cost_from_usage  # noqa: E402

API_URL = "https://api.deepseek.com/chat/completions"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DEEPSEEK_USAGE_DB", os.path.join(BASE_DIR, "usage.db"))
JSONL_PATH = os.environ.get(
    "DEEPSEEK_USAGE_JSONL", os.path.join(BASE_DIR, "usage.jsonl")
)
DEFAULT_MODEL = "deepseek-v4-flash"
# 流式空闲超时（秒）：等下一个字节最多等多久；长停顿的 agent/推理流用更大值
STREAM_IDLE_TIMEOUT = 600


# --------------------------------------------------------------------------- #
# 工具函数
# --------------------------------------------------------------------------- #


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def resolve_token() -> str:
    """读取 DEEPSEEK_API_KEY 环境变量。"""
    val = os.environ.get("DEEPSEEK_API_KEY")
    if val and val.strip():
        return val.strip()
    sys.exit(
        "无法获取 DeepSeek API key：请在终端设置环境变量 DEEPSEEK_API_KEY。"
        "不要把 key 发给任何 AI。"
    )


def validate_token_format(token: str) -> list:
    """检查 DeepSeek API key 格式，返回问题列表（空=看起来正常）。

    只做"格式提醒"，不硬性拦截——因为兼容提供商的 token 可能不以 sk- 开头。
    """
    issues = []
    if not token:
        issues.append("token 为空")
        return issues
    if not token.startswith("sk-"):
        issues.append(
            f"不以 sk- 开头（前 {len(token[:4])} 字符为 {token[:4]!r}；兼容提供商可能不同）"
        )
    if len(token) < 20:
        issues.append(f"长度仅 {len(token)} 字符（官方 DeepSeek key 通常约 35 字符）")
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", token):
        issues.append("含非常见字符（正常应为字母/数字/-/_）")
    return issues


def warn_token_format(token: str, where: str = "key") -> None:
    for issue in validate_token_format(token):
        print(f"[提醒] {where} 格式可能有问题：{issue}", file=sys.stderr)


def init_db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA journal_mode=WAL")  # WAL：降低多线程并发写锁冲突
    con.execute("""
        CREATE TABLE IF NOT EXISTS usage_log(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            model TEXT,
            prompt_tokens INTEGER,
            completion_tokens INTEGER,
            total_tokens INTEGER,
            cache_hit_tokens INTEGER,
            cache_miss_tokens INTEGER,
            n_messages INTEGER,
            input_chars INTEGER,
            output_chars INTEGER,
            stream INTEGER,
            status INTEGER,
            error TEXT,
            cost REAL
        )
        """)
    # 旧库补列：不删已有记录，缺 cost 列就补上
    cols = {r[1] for r in con.execute("PRAGMA table_info(usage_log)")}
    if "cost" not in cols:
        con.execute("ALTER TABLE usage_log ADD COLUMN cost REAL")
    con.commit()
    return con


def insert_log(
    con,
    *,
    model,
    pt,
    ct,
    tt,
    cache_hit,
    cache_miss,
    nmsg,
    ich,
    och,
    stream,
    status,
    error=None,
):
    ts = now_iso()
    # 费用：用共用定价（common/pricing）按真实 usage 算；token 缺失（如出错）时为 None
    cost = (
        cost_from_usage(pt, ct, cache_hit, cache_miss, model=model)
        if all(v is not None for v in (pt, ct, cache_hit, cache_miss))
        else None
    )
    con.execute(
        "INSERT INTO usage_log(ts,model,prompt_tokens,completion_tokens,total_tokens,"
        "cache_hit_tokens,cache_miss_tokens,n_messages,input_chars,output_chars,"
        "stream,status,error,cost) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            ts,
            model,
            pt,
            ct,
            tt,
            cache_hit,
            cache_miss,
            nmsg,
            ich,
            och,
            1 if stream else 0,
            status,
            error,
            cost,
        ),
    )
    con.commit()
    with open(JSONL_PATH, "a", encoding="utf-8") as f:
        f.write(
            json.dumps(
                {
                    "ts": ts,
                    "model": model,
                    "prompt_tokens": pt,
                    "completion_tokens": ct,
                    "total_tokens": tt,
                    "cache_hit_tokens": cache_hit,
                    "cache_miss_tokens": cache_miss,
                    "n_messages": nmsg,
                    "input_chars": ich,
                    "output_chars": och,
                    "stream": bool(stream),
                    "status": status,
                    "error": error,
                    "cost": cost,
                },
                ensure_ascii=False,
            )
            + "\n"
        )


def http_call(authorization: str, body: dict, stream: bool = False, timeout: int = 120):
    """向 DeepSeek API 发起请求，返回 (status, headers, raw_bytes)。

    authorization 是完整的 Authorization 头值（如 'Bearer sk-...'）：
    - 代理模式：优先透传客户端带来的头（扩展已带 key，无需再配环境变量）
    - check 模式：由 resolve_token() 构造
    """
    payload = dict(body)
    if stream:
        # 让流式响应在末尾携带 usage chunk
        payload.setdefault("stream_options", {}).setdefault("include_usage", True)
    headers = {"Authorization": authorization, "Content-Type": "application/json"}
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def _usage_fields(usage: dict):
    """从 usage 对象提取字段（缺省为 None）。"""
    return (
        usage.get("prompt_tokens"),
        usage.get("completion_tokens"),
        usage.get("total_tokens"),
        usage.get("prompt_cache_hit_tokens"),
        usage.get("prompt_cache_miss_tokens"),
    )


_print_lock = threading.Lock()  # 多线程同时打印时不串行


# --------------------------------------------------------------------------- #
# 终端美化：显示宽度感知对齐 / k·M 缩写 / 模型截断 / 底部统计栏
# --------------------------------------------------------------------------- #

_status_enabled = False  # proxy 模式 + TTY 时开启底部统计栏；非 TTY 退化为纯追加


def _disp_width(s: str) -> int:
    """终端显示宽度：中日韩全角字符按 2 列计，保证含 ￥/中文时对齐。"""
    return sum(2 if unicodedata.east_asian_width(ch) in ("F", "W") else 1 for ch in s)


def _pad(s: str, width: int, align: str = "<") -> str:
    """按显示宽度补齐/截断；align '<' 左对齐，'>' 右对齐。"""
    pad = width - _disp_width(s)
    if pad <= 0:
        return s
    return s + " " * pad if align == "<" else " " * pad + s


def _fmt_num(n) -> str:
    """token 缩写：<1000 原样 → <1e6 一位小数 k → 否则两位小数 M。"""
    if n is None:
        return "—"
    if n < 1000:
        return str(n)
    if n < 1_000_000:
        return f"{n / 1000:.1f}k"
    return f"{n / 1e6:.2f}M"


# 表格列宽（含尾随空格作列间分隔）；表头与行共用同一套宽度保证对齐
_HDR = (
    _pad("时间", 10)
    + _pad("输入/输出", 13, ">")
    + _pad("token总/缓存", 16, ">")
    + _pad("费用总/缓存", 18, ">")
    + _pad("状态", 6, ">")
)
_SEP = "-" * _disp_width(_HDR)


def _fmt_usage(model, pt, ct, tt, ch, cm, stream, status, error=None) -> str:
    """把一次请求的 usage + 费用 格式化成一行（模型启动时统一说明，行内省略）。

    列：时间 | 输入/输出(p/c) | token总/缓存(t/cH) | 费用总/缓存 | 状态。
    """
    ts = datetime.now().strftime("%H:%M:%S")
    p_s = _fmt_num(pt) if pt is not None else "—"
    c_s = _fmt_num(ct) if ct is not None else "—"
    t_s = _fmt_num(tt) if tt is not None else "—"
    ch_s = _fmt_num(ch) if ch is not None else "—"
    if error:
        pc_col, tok_col, cost_col = "—", "—", "—"
    else:
        pc_col = f"{p_s}/{c_s}"
        tok_col = f"{t_s}/{ch_s}"
        if pt is not None and ct is not None and ch is not None and cm is not None:
            cost = cost_from_usage(pt, ct, ch, cm, model=model)
            pr = PRICING.get(model, PRICING[DEFAULT_MODEL])
            ch_cost = ch * pr["cache_hit"] / 1e6
            cost_col = f"￥{cost:.4f}/{ch_cost:.4f}"
        else:
            cost_col = "—"
    mode = "s" if stream else "o"
    row = (
        _pad(ts, 10)
        + _pad(pc_col, 13, ">")
        + _pad(tok_col, 16, ">")
        + _pad(cost_col, 18, ">")
        + _pad(f"{mode}{status}", 6, ">")
    )
    if error:
        row += "  ✗ " + (error or "").splitlines()[0][:80]
    return row


def _today_stats():
    """今天（本地时区）的累计；费用用行内已存 cost 精确求和（落库未预先舍入）。"""
    con = init_db()
    local_now = datetime.now().astimezone()
    start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    rows = con.execute(
        "SELECT model,prompt_tokens,completion_tokens,total_tokens,"
        "cache_hit_tokens,cost FROM usage_log WHERE ts>=? AND ts<?",
        (
            start.astimezone(timezone.utc).isoformat(timespec="seconds"),
            end.astimezone(timezone.utc).isoformat(timespec="seconds"),
        ),
    ).fetchall()
    con.close()
    p = c = t = ch = cost = ch_cost = 0
    for model, pt, ct, tt, chh, row_cost in rows:
        p += pt or 0
        c += ct or 0
        t += tt or 0
        ch += chh or 0
        cost += row_cost or 0  # NULL（错误/老记录）按 0 兜底
        pr = PRICING.get(model, PRICING[DEFAULT_MODEL])
        ch_cost += (chh or 0) * pr["cache_hit"] / 1e6
    return p, c, t, ch, cost, ch_cost


def _status_text() -> str:
    """底部统计栏：日期 + 今天累计，与实时行同格式（纯数值对，无标签）。"""
    p, c, t, ch, cost, ch_cost = _today_stats()
    date = datetime.now().strftime("%Y-%m-%d")
    return (
        f"{date}  {_fmt_num(p)}/{_fmt_num(c)}  "
        f"{_fmt_num(t)}/{_fmt_num(ch)}  ￥{cost:.4f}/{ch_cost:.4f}"
    )


def _emit_row(line: str) -> None:
    """实时行 + 底部统计栏：整段在锁内完成，避免多线程打印交错。

    关键：统计栏用 sys.stdout.write 且不加换行，让光标停在统计栏行内；
    否则 print 的 \n 会把光标推到下方空行，下次 \r\x1b[K 清不掉旧统计栏。
    """
    with _print_lock:
        if _status_enabled:
            sys.stdout.write("\r\x1b[K")
        print(line, flush=True)
        if _status_enabled:
            sys.stdout.write(_status_text())
            sys.stdout.flush()


# --------------------------------------------------------------------------- #
# check：一次性验证 + 记录
# --------------------------------------------------------------------------- #


def cmd_check(args):
    token = resolve_token()
    warn_token_format(token, "check key")  # 软校验：格式怪只是提醒，仍会发请求
    body = {
        "model": args.model,
        "messages": [{"role": "user", "content": args.prompt}],
        "stream": False,
        "temperature": 0,
        "max_tokens": args.max_tokens,
    }
    print(f"正在请求 {API_URL}  (model={args.model}) ...")
    status, _h, out = http_call(
        "Bearer " + token, body, stream=False, timeout=args.timeout
    )
    if status != 200:
        sys.exit(f"HTTP {status}\n{out.decode('utf-8', 'replace')[:1000]}")
    data = json.loads(out.decode("utf-8", "replace"))
    usage = data.get("usage") or {}
    pt, ct, tt, ch, cm = _usage_fields(usage)
    print(
        json.dumps(
            {
                "status": status,
                "model": data.get("model"),
                "usage": usage,
                "reply": (data.get("choices") or [{}])[0]
                .get("message", {})
                .get("content", ""),
            },
            ensure_ascii=False,
            indent=2,
        )
    )

    con = init_db()
    insert_log(
        con,
        model=data.get("model") or args.model,
        pt=pt,
        ct=ct,
        tt=tt,
        cache_hit=ch,
        cache_miss=cm,
        nmsg=1,
        ich=len(args.prompt),
        och=len(
            (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        ),
        stream=False,
        status=status,
    )
    con.close()
    print(f"\n已记录到 {DB_PATH}，共 {tt or 0} tokens。")


# --------------------------------------------------------------------------- #
# proxy：本地 OpenAI 兼容代理 + 记录（事件触发式 HTTP 服务器）
# --------------------------------------------------------------------------- #


class Handler(BaseHTTPRequestHandler):
    server_version = "DeepSeekUsageLogger/1.0"
    protocol_version = "HTTP/1.1"  # 允许 chunked 流式（真流式透传需要）

    def log_message(self, fmt, *args):  # 静默默认日志，避免刷屏
        pass

    def _send(self, code, body: bytes, ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.end_headers()

    def _record(
        self, model, pt, ct, tt, ch, cm, nmsg, ich, och, stream, status, error=None
    ):
        """落库 + 实时打印一行（非流式与流式共用）。"""
        con = init_db()
        insert_log(
            con,
            model=model,
            pt=pt,
            ct=ct,
            tt=tt,
            cache_hit=ch,
            cache_miss=cm,
            nmsg=nmsg,
            ich=ich,
            och=och,
            stream=stream,
            status=status,
            error=error,
        )
        con.close()
        _emit_row(_fmt_usage(model, pt, ct, tt, ch, cm, stream, status, error))

    def _proxy_stream(self, auth, body, model, messages, input_chars):
        """真流式透传：边从 DeepSeek 收 chunk 边转发给客户端，末尾抓 usage 落库。"""
        payload = dict(body)
        payload.setdefault("stream_options", {}).setdefault("include_usage", True)
        req = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": auth, "Content-Type": "application/json"},
            method="POST",
        )
        try:
            # 流式用更大的空闲超时（长停顿不误杀）；非流式才用 args_timeout
            resp = urllib.request.urlopen(req, timeout=STREAM_IDLE_TIMEOUT)
        except urllib.error.HTTPError as e:
            err = e.read()
            ctype = e.headers.get("Content-Type", "application/json")
            self._send(e.code, err, ctype=ctype)
            self._record(
                model,
                None,
                None,
                None,
                None,
                None,
                len(messages),
                input_chars,
                None,
                True,
                e.code,
                err[:200].decode("utf-8", "replace"),
            )
            return
        except Exception as e:
            self._record(
                model,
                None,
                None,
                None,
                None,
                None,
                len(messages),
                input_chars,
                None,
                True,
                0,
                str(e),
            )
            self._send(500, json.dumps({"error": str(e)}).encode())
            return

        # 先发响应头（HTTP/1.1 + chunked 流式）
        ctype = resp.headers.get("Content-Type", "text/event-stream")
        self.send_response(resp.status)
        self.send_header("Content-Type", ctype)
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        # 边收边转；同时从 SSE 里抓最后一个 data: 的 usage（[DONE] 之前）
        # #2：跨块缓存不完整行，避免长 data 行被 8KB 块切断
        # #1：客户端断开时停止转发，但仍读完 DeepSeek 响应以抓 usage（被中断的生成照样计费）
        last_usage = {}
        buf = ""
        client_gone = False
        try:
            while True:
                block = resp.read(8192)
                if not block:
                    break
                if not client_gone:
                    try:
                        self.wfile.write(
                            f"{len(block):X}\r\n".encode() + block + b"\r\n"
                        )
                        self.wfile.flush()
                    except Exception:
                        client_gone = True  # 客户端断开：停止转发，继续读完抓 usage
                buf += block.decode("utf-8", "replace")
                lines = buf.split("\n")
                buf = lines.pop()  # 最后一段可能不完整，留到下一块
                for line in lines:
                    line = line.strip("\r")
                    if line.startswith("data:"):
                        p = line[5:].strip()
                        if p and p != "[DONE]":
                            try:
                                last_usage = json.loads(p).get("usage") or {}
                            except Exception:
                                pass
            if buf:  # 处理流末尾残留的未换行片段
                line = buf.strip("\r")
                if line.startswith("data:"):
                    p = line[5:].strip()
                    if p and p != "[DONE]":
                        try:
                            last_usage = json.loads(p).get("usage") or {}
                        except Exception:
                            pass
            if not client_gone:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
        except Exception as e:
            # 读取阶段异常（网络错误/超时），非客户端断开
            self._record(
                model,
                None,
                None,
                None,
                None,
                None,
                len(messages),
                input_chars,
                None,
                True,
                0,
                str(e),
            )
            try:
                resp.close()
            except Exception:
                pass
            return
        try:
            resp.close()
        except Exception:
            pass

        pt, ct, tt, ch, cm = _usage_fields(last_usage)
        self._record(
            model,
            pt,
            ct,
            tt,
            ch,
            cm,
            len(messages),
            input_chars,
            None,
            True,
            resp.status,
        )

    def do_POST(self):
        # 事件触发：只有客户端发来 /chat/completions 请求才干活
        path = urlparse(self.path).path
        if path not in ("/v1/chat/completions", "/chat/completions"):
            self._send(404, b'{"error":"not found"}')
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw or b"{}")
        except Exception as e:
            self._send(400, json.dumps({"error": str(e)}).encode())
            return

        stream = bool(body.get("stream", False))
        messages = body.get("messages", [])
        model = body.get("model", DEFAULT_MODEL)
        input_chars = sum(len(str(m.get("content", ""))) for m in messages)

        # 认证：优先透传客户端带来的 Authorization 头（扩展已带 key，无需再配环境变量）；
        # 客户端没带头时（如裸客户端）才回退到环境变量 key
        client_auth = self.headers.get("Authorization")
        if client_auth and client_auth.strip():
            auth = client_auth.strip()
        else:
            try:
                auth = "Bearer " + resolve_token()
            except SystemExit as e:
                self._send(500, json.dumps({"error": str(e)}).encode())
                return

        if stream:
            # 真流式：边收边转发，避免"等全部生成完才出现"
            self._proxy_stream(auth, body, model, messages, input_chars)
            return

        try:
            status, _h, out = http_call(auth, body, stream=stream, timeout=args_timeout)
        except Exception as e:
            con = init_db()
            insert_log(
                con,
                model=model,
                pt=None,
                ct=None,
                tt=None,
                cache_hit=None,
                cache_miss=None,
                nmsg=len(messages),
                ich=input_chars,
                och=None,
                stream=stream,
                status=0,
                error=str(e),
            )
            con.close()
            _emit_row(
                _fmt_usage(model, None, None, None, None, None, stream, 0, str(e))
            )
            self._send(500, json.dumps({"error": str(e)}).encode())
            return

        # 解析并记录 usage
        pt = ct = tt = ch = cm = och = None
        if not stream:
            try:
                d = json.loads(out.decode("utf-8", "replace"))
                pt, ct, tt, ch, cm = _usage_fields(d.get("usage") or {})
                och = len(
                    (d.get("choices") or [{}])[0].get("message", {}).get("content")
                    or ""
                )
            except Exception:
                pass
        else:
            last = None
            try:
                for line in out.decode("utf-8", "replace").splitlines():
                    if line.startswith("data:"):
                        payload = line[5:].strip()
                        if payload and payload != "[DONE]":
                            last = json.loads(payload)
            except Exception:
                last = None
            pt, ct, tt, ch, cm = _usage_fields((last or {}).get("usage") or {})

        con = init_db()
        insert_log(
            con,
            model=model,
            pt=pt,
            ct=ct,
            tt=tt,
            cache_hit=ch,
            cache_miss=cm,
            nmsg=len(messages),
            ich=input_chars,
            och=och,
            stream=stream,
            status=status,
        )
        con.close()
        _emit_row(_fmt_usage(model, pt, ct, tt, ch, cm, stream, status))

        # 转发给客户端
        ctype = _h.get("Content-Type", "application/json")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(out)


args_timeout = 120  # proxy 处理器里引用的请求超时


def cmd_proxy(args):
    global args_timeout
    args_timeout = args.timeout
    # 环境变量 key 是"可选兜底"：扩展透传时不需要；裸客户端 / check 才需要
    env_key = os.environ.get("DEEPSEEK_API_KEY")
    if env_key and env_key.strip():
        warn_token_format(env_key.strip(), "proxy key")
    else:
        print(
            "提示: 未设置 DEEPSEEK_API_KEY，将依赖客户端自带 Authorization"
            "（扩展透传场景适用）"
        )
    init_db()
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as e:
        sys.exit(
            f"无法启动代理：端口 {args.port} 可能被占用（{e}）。"
            "请换端口（--port）或先停掉占用者。"
        )
    print(f"本地代理已启动: http://127.0.0.1:{args.port}/v1/chat/completions")
    print("把任何 OpenAI 兼容客户端的 base_url 指向这里，每次请求的 usage 都会记录到")
    print(f" 模型  : 透传客户端请求（默认 {DEFAULT_MODEL}）")
    print(f"  DB   : {DB_PATH}")
    print(f"  JSONL: {JSONL_PATH}")
    print("Ctrl+C 停止。")
    # 终端美化：TTY 下打印表头 + 底部统计栏；被重定向（管道/文件）时退化为纯追加
    global _status_enabled
    _status_enabled = sys.stdout.isatty()
    if _status_enabled:
        print(_HDR)
        print(_SEP)
        sys.stdout.write(
            _status_text()
        )  # 不加换行：光标停在统计栏行内，下次才能清掉重写
        sys.stdout.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        if _status_enabled:
            sys.stdout.write("\r\x1b[K")
        print("已停止。")
        srv.server_close()


# --------------------------------------------------------------------------- #
# list：查看最近记录（验证管线用）
# --------------------------------------------------------------------------- #


def cmd_list(args):
    con = init_db()
    rows = con.execute(
        "SELECT ts,model,prompt_tokens,completion_tokens,total_tokens,"
        "cache_hit_tokens,n_messages,stream,status,error,cost "
        "FROM usage_log ORDER BY id DESC LIMIT ?",
        (args.limit,),
    ).fetchall()
    con.close()
    if not rows:
        print("还没有任何记录。先运行 `python proxy.py check` 或启动 proxy。")
        return
    hdr = f"{'ts':<26}{'model':<20}{'prompt':>9}{'complet':>9}{'total':>9}{'cacheH':>9}{'费用':>9}{'msg':>4}{'strm':>5}{'st':>4}"
    print(hdr)
    print("-" * len(hdr))
    for ts, model, pt, ct, tt, ch, nm, st, status, err, cost in rows:
        cost_s = "" if cost is None else f"{cost:.4f}"
        print(
            f"{ts:<26}{str(model or '')[:19]:<20}{str(pt):>9}{str(ct):>9}"
            f"{str(tt):>9}{str(ch):>9}{cost_s:>9}{nm:>4}{'Y' if st else 'N':>5}{status:>4}"
            + (f"  err={err}" if err else "")
        )


def main():
    ap = argparse.ArgumentParser(
        description="路2（精确）：拦截请求，把响应里的 usage 存进 usage.db"
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_check = sub.add_parser("check", help="一次性调用并记录一次真实 usage")
    p_check.add_argument(
        "--model", default=DEFAULT_MODEL, help=f"模型名（默认 {DEFAULT_MODEL}）"
    )
    p_check.add_argument("--prompt", default="hi", help="测试提示词（默认 'hi'）")
    p_check.add_argument("--max-tokens", type=int, default=16)
    p_check.add_argument("--timeout", type=int, default=120)
    p_check.set_defaults(func=cmd_check)

    p_proxy = sub.add_parser("proxy", help="本地 OpenAI 兼容代理，转发并记录 usage")
    p_proxy.add_argument("--port", type=int, default=8080)
    p_proxy.add_argument("--timeout", type=int, default=120)
    p_proxy.set_defaults(func=cmd_proxy)

    p_list = sub.add_parser("list", help="打印最近记录")
    p_list.add_argument("--limit", type=int, default=20)
    p_list.set_defaults(func=cmd_list)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
