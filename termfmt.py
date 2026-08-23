#!/usr/bin/env python3
"""termfmt.py — 终端实时输出：列对齐表格行 / 底部统计栏的格式化与渲染。

供 proxy.py 使用：proxy 负责 HTTP 与 DB，本模块负责"怎么把一行打好看"。
底部统计栏要查 DB，因此 emit_row 接收一个 status_text 回调（由 proxy 提供，
返回当前统计栏字符串），本模块自身不碰数据库。

依赖：pricing（定价/费用）。仅标准库。
"""

import sys
import threading
import unicodedata
from datetime import datetime

from pricing import PRICING, DEFAULT_MODEL, cost_from_usage

_status_enabled = False  # TTY 时开启底部统计栏；非 TTY 退化为纯追加
_print_lock = threading.Lock()  # 多线程同时打印时不串行


def enable(on: bool) -> None:
    """开启/关闭底部统计栏（由 proxy 在启动时按 isatty 决定）。"""
    global _status_enabled
    _status_enabled = on


def is_enabled() -> bool:
    return _status_enabled


def _disp_width(s: str) -> int:
    """终端显示宽度：中日韩全角字符按 2 列计，保证含 ￥/中文时对齐。"""
    return sum(2 if unicodedata.east_asian_width(ch) in ("F", "W") else 1 for ch in s)


def _pad(s: str, width: int, align: str = "<") -> str:
    """按显示宽度补齐/截断；align '<' 左对齐，'>' 右对齐。"""
    pad = width - _disp_width(s)
    if pad <= 0:
        return s
    return s + " " * pad if align == "<" else " " * pad + s


def fmt_num(n) -> str:
    """token 缩写：<1000 原样 → <1e6 一位小数 k → 否则两位小数 M。"""
    if n is None:
        return "—"
    if n < 1000:
        return str(n)
    if n < 1_000_000:
        return f"{n / 1000:.1f}k"
    return f"{n / 1e6:.2f}M"


# 表格列宽（含尾随空格作列间分隔）；表头与行共用同一套宽度保证对齐
HDR = (
    _pad("时间", 10)
    + _pad("输入/输出", 13, ">")
    + _pad("token总/缓存", 16, ">")
    + _pad("费用总/缓存", 18, ">")
    + _pad("状态", 6, ">")
)
SEP = "-" * _disp_width(HDR)


def fmt_row(model, pt, ct, tt, ch, cm, stream, status, error=None) -> str:
    """把一次请求的 usage + 费用 格式化成一行（模型启动时统一说明，行内省略）。

    列：时间 | 输入/输出(p/c) | token总/缓存(t/cH) | 费用总/缓存 | 状态。
    """
    ts = datetime.now().strftime("%H:%M:%S")
    p_s = fmt_num(pt) if pt is not None else "—"
    c_s = fmt_num(ct) if ct is not None else "—"
    t_s = fmt_num(tt) if tt is not None else "—"
    ch_s = fmt_num(ch) if ch is not None else "—"
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


def emit_row(line: str, status_text) -> None:
    """实时行 + 底部统计栏：整段在锁内完成，避免多线程打印交错。

    status_text：可调用对象，返回当前统计栏字符串（由 proxy 提供，内部查 DB）。
    关键：统计栏用 sys.stdout.write 且不加换行，让光标停在统计栏行内；
    否则 print 的 \\n 会把光标推到下方空行，下次 \\r\\x1b[K 清不掉旧统计栏。
    """
    with _print_lock:
        if _status_enabled:
            sys.stdout.write("\r\x1b[K")
        print(line, flush=True)
        if _status_enabled:
            sys.stdout.write(status_text())
            sys.stdout.flush()
