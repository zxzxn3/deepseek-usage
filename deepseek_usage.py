#!/usr/bin/env python3
"""deepseek_usage.py — 通过 DeepSeek API 获取真实 token 用量并记录/绘图。

背景
----
DeepSeek 的 API 是 OpenAI 兼容的：每次响应都带 usage 对象（prompt_tokens /
completion_tokens / total_tokens，以及缓存相关的 prompt_cache_hit_tokens /
prompt_cache_miss_tokens）。官方 platform.deepseek.com 仪表板也有历史汇总。
本工具在本地做三件事：

  check   一次性调用 DeepSeek API，打印并记录一次真实 usage（验证 key 可用）
  proxy   本地 OpenAI 兼容代理：把请求转发给 DeepSeek API，并记录每次 usage
  report  汇总记录并生成 matplotlib 图表
  list    打印最近 N 条记录

凭据
----
读取环境变量 DEEPSEEK_API_KEY。
不要把你的 key 发给任何 AI —— 直接在终端里设置并运行即可。

用法示例
--------
    $env:DEEPSEEK_API_KEY = "sk-..."          # 在终端里设置，别在聊天里发
    python deepseek_usage.py check --model deepseek-v4-flash --prompt "hi"
    python deepseek_usage.py proxy --port 8080
    python deepseek_usage.py list --limit 20
    python deepseek_usage.py report
"""

import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

API_URL = "https://api.deepseek.com/chat/completions"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DEEPSEEK_USAGE_DB", os.path.join(BASE_DIR, "usage.db"))
JSONL_PATH = os.environ.get(
    "DEEPSEEK_USAGE_JSONL", os.path.join(BASE_DIR, "usage.jsonl")
)
CHART_DIR = os.path.join(BASE_DIR, "charts")
DEFAULT_MODEL = "deepseek-v4-flash"


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


def deepseek_headers(token: str) -> dict:
    return {"Authorization": "Bearer " + token, "Content-Type": "application/json"}


def init_db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
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
            error TEXT
        )
        """)
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
    con.execute(
        "INSERT INTO usage_log(ts,model,prompt_tokens,completion_tokens,total_tokens,"
        "cache_hit_tokens,cache_miss_tokens,n_messages,input_chars,output_chars,"
        "stream,status,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
                },
                ensure_ascii=False,
            )
            + "\n"
        )


def http_call(token, body: dict, stream: bool = False, timeout: int = 120):
    """向 DeepSeek API 发起请求，返回 (status, headers, raw_bytes)。"""
    payload = dict(body)
    if stream:
        # 让流式响应在末尾携带 usage chunk
        payload.setdefault("stream_options", {}).setdefault("include_usage", True)
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers=deepseek_headers(token),
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


# --------------------------------------------------------------------------- #
# check：一次性验证 + 记录
# --------------------------------------------------------------------------- #


def cmd_check(args):
    token = resolve_token()
    body = {
        "model": args.model,
        "messages": [{"role": "user", "content": args.prompt}],
        "stream": False,
        "temperature": 0,
        "max_tokens": args.max_tokens,
    }
    print(f"正在请求 {API_URL}  (model={args.model}) ...")
    status, _h, out = http_call(token, body, stream=False, timeout=args.timeout)
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
# proxy：本地 OpenAI 兼容代理 + 记录
# --------------------------------------------------------------------------- #


class Handler(BaseHTTPRequestHandler):
    server_version = "DeepSeekUsageLogger/1.0"

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

    def do_POST(self):
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

        try:
            token = resolve_token()
        except SystemExit as e:
            self._send(500, json.dumps({"error": str(e)}).encode())
            return

        try:
            status, _h, out = http_call(
                token, body, stream=stream, timeout=args_timeout
            )
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
    resolve_token()  # 先验证 key 可解析
    init_db()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"本地代理已启动: http://127.0.0.1:{args.port}/v1/chat/completions")
    print("把任何 OpenAI 兼容客户端的 base_url 指向这里，每次请求的 usage 都会记录到")
    print(f"  DB   : {DB_PATH}")
    print(f"  JSONL: {JSONL_PATH}")
    print("Ctrl+C 停止。")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
        srv.server_close()


# --------------------------------------------------------------------------- #
# list / report
# --------------------------------------------------------------------------- #


def cmd_list(args):
    con = init_db()
    rows = con.execute(
        "SELECT ts,model,prompt_tokens,completion_tokens,total_tokens,"
        "cache_hit_tokens,n_messages,stream,status,error "
        "FROM usage_log ORDER BY id DESC LIMIT ?",
        (args.limit,),
    ).fetchall()
    con.close()
    if not rows:
        print("还没有任何记录。先运行 `python deepseek_usage.py check` 或启动 proxy。")
        return
    hdr = f"{'ts':<26}{'model':<20}{'prompt':>7}{'complet':>9}{'total':>8}{'cache':>8}{'msg':>4}{'strm':>5}{'st':>4}"
    print(hdr)
    print("-" * len(hdr))
    for ts, model, pt, ct, tt, ch, nm, st, status, err in rows:
        print(
            f"{ts:<26}{str(model or '')[:19]:<20}{str(pt):>7}{str(ct):>9}"
            f"{str(tt):>8}{str(ch):>8}{nm:>4}{'Y' if st else 'N':>5}{status:>4}"
            + (f"  err={err}" if err else "")
        )


def cmd_report(args):
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib import font_manager
    except ImportError:
        plt = None
        print("未安装 matplotlib，仅输出文本汇总。")

    con = init_db()
    daily = con.execute("""
        SELECT date(ts) AS d,
               SUM(prompt_tokens)     AS p,
               SUM(completion_tokens) AS c,
               SUM(total_tokens)      AS t,
               SUM(cache_hit_tokens)  AS h,
               COUNT(*)               AS n
        FROM usage_log
        WHERE total_tokens IS NOT NULL AND status = 200
        GROUP BY d ORDER BY d
        """).fetchall()
    total = con.execute(
        "SELECT COUNT(*), COALESCE(SUM(total_tokens),0), COALESCE(SUM(prompt_tokens),0),"
        "       COALESCE(SUM(completion_tokens),0), COALESCE(SUM(cache_hit_tokens),0)"
        " FROM usage_log WHERE total_tokens IS NOT NULL AND status=200"
    ).fetchone()
    con.close()

    if total and total[0]:
        print(
            f"有效请求 {total[0]} 条 | 总 token {total[1]} | prompt {total[2]}"
            f" | completion {total[3]} | 缓存命中 {total[4]}"
        )
    if not daily:
        print("没有带 usage 的记录（total_tokens 为 NULL 或状态非 200 的不会统计）。")
        return

    print(
        f"\n{'日期':<12}{'请求数':>6}{'prompt':>10}{'completion':>12}{'cache_hit':>10}{'合计':>10}"
    )
    for d, p, c, t, h, n in daily:
        print(f"{d:<12}{n:>6}{p:>10}{c:>12}{str(h):>10}{t:>10}")

    if plt is None:
        return
    # 中文字体
    for name in ("Microsoft YaHei", "SimHei", "PingFang SC"):
        if any(
            name.lower() in f.name.lower() for f in font_manager.fontManager.ttflist
        ):
            plt.rcParams["font.sans-serif"] = [name]
            break
    plt.rcParams["axes.unicode_minus"] = False

    days = [r[0] for r in daily]
    ps = [r[1] for r in daily]
    cs = [r[2] for r in daily]
    ts = [r[3] for r in daily]

    fig, ax = plt.subplots(figsize=(10, 5))
    x = range(len(days))
    ax.bar(x, ps, label="prompt tokens", color="#4C72B0")
    ax.bar(x, cs, bottom=ps, label="completion tokens", color="#DD8452")
    ax.plot(x, ts, color="#C44E52", marker="o", label="total")
    ax.set_xticks(list(x))
    ax.set_xticklabels(days, rotation=45, ha="right")
    ax.set_ylabel("tokens")
    ax.set_title("DeepSeek 每日 token 用量")
    ax.legend()
    fig.tight_layout()

    os.makedirs(CHART_DIR, exist_ok=True)
    out = os.path.join(CHART_DIR, "usage_daily.png")
    fig.savefig(out, dpi=150)
    print(f"\n图表已保存: {out}")


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #


def main():
    ap = argparse.ArgumentParser(
        description="DeepSeek API token 用量记录与可视化（纯标准库 + matplotlib）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_check = sub.add_parser("check", help="一次性调用并记录一次真实 usage")
    p_check.add_argument(
        "--model", default=DEFAULT_MODEL, help=f"模型名（默认 {DEFAULT_MODEL}）"
    )
    p_check.add_argument(
        "--prompt", default="hi", help="测试提示词（默认 'hi'，尽量省 token）"
    )
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

    p_report = sub.add_parser("report", help="汇总并生成图表")
    p_report.set_defaults(func=cmd_report)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
