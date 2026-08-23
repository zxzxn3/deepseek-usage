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
from datetime import datetime, timezone

from pricing import PRICING, DEFAULT_MODEL, cost_from_usage, is_peak_bt

_status_enabled = False  # TTY 时开启底部统计栏；非 TTY 退化为纯追加
_color_enabled = False  # TTY 时给状态码/费用/错误上色；非 TTY 保持纯文本
_print_lock = threading.Lock()  # 多线程同时打印时不串行

# ANSI 颜色（仅 _color_enabled 时生效）
_RESET = "\x1b[0m"
_RED = "\x1b[31m"
_GREEN = "\x1b[32m"
_YELLOW = "\x1b[33m"


def enable(on: bool) -> None:
    """开启/关闭终端美化（底部统计栏 + 颜色），由 proxy 按 isatty 决定。"""
    global _status_enabled, _color_enabled
    _status_enabled = on
    _color_enabled = on


def is_enabled() -> bool:
    return _status_enabled


def _c(code, s):
    """给字符串上色；非 TTY 时原样返回，避免把转义码写进管道/文件。"""
    return f"{code}{s}{_RESET}" if _color_enabled else s


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


def _status_color(status):
    """状态码 → 颜色：2xx 绿、4xx/5xx/0 红、其它不加色。"""
    if status is None:
        return None
    if 200 <= status < 300:
        return _GREEN
    if status == 0 or status >= 400:
        return _RED
    return None


def _cell(s, width, align=">", color=None):
    """按列宽补齐后上色（先算宽、后上色，颜色码不破坏对齐）。"""
    padded = _pad(s, width, align)
    return _c(color, padded) if color else padded


def money(s: str) -> str:
    """给金额上色（黄色），供统计栏等金额显示用。"""
    return _c(_YELLOW, s)


def peak_badge(peak: bool) -> str:
    """计价模式标记：高峰(×2) 红 / 空闲 绿。"""
    return _c(_RED, "[高峰 ×2]") if peak else _c(_GREEN, "[空闲]")


def fmt_row(
    model, pt, ct, tt, ch, cm, stream, status, error=None, ts=None, peak=None
) -> str:
    """把一次请求的 usage + 费用 格式化成一行（模型启动时统一说明，行内省略）。

    列：时间 | 输入/输出(p/c) | token总/缓存(t/cH) | 费用总/缓存 | 状态。
    ts：可选，覆盖当前时间（供 cmd_list 显示历史记录）；默认取现在。
    peak：可选，是否高峰价；缺省按当前时间（北京时间）判断。
    颜色（TTY 时）：状态码 2xx 绿 / 4xx·5xx·0 红，费用黄，错误红。
    """
    if ts is None:
        ts = datetime.now().strftime("%H:%M:%S")
    if peak is None:
        peak = is_peak_bt(datetime.now(timezone.utc))
    p_s = fmt_num(pt) if pt is not None else "—"
    c_s = fmt_num(ct) if ct is not None else "—"
    t_s = fmt_num(tt) if tt is not None else "—"
    ch_s = fmt_num(ch) if ch is not None else "—"
    if error:
        pc_col, tok_col, cost_col, cost_color = "—", "—", "—", None
    else:
        pc_col = f"{p_s}/{c_s}"
        tok_col = f"{t_s}/{ch_s}"
        if pt is not None and ct is not None and ch is not None and cm is not None:
            cost = cost_from_usage(pt, ct, ch, cm, model=model, peak=peak)
            pr = PRICING.get(model, PRICING[DEFAULT_MODEL])
            ch_cost = ch * pr["cache_hit"] / 1e6 * (2.0 if peak else 1.0)
            cost_col = f"￥{cost:.4f}/{ch_cost:.4f}"
            cost_color = _YELLOW
        else:
            cost_col, cost_color = "—", None
    mode = "s" if stream else "o"
    row = (
        _pad(ts, 10)
        + _cell(pc_col, 13, ">")
        + _cell(tok_col, 16, ">")
        + _cell(cost_col, 18, ">", cost_color)
        + _cell(f"{mode}{status}", 6, ">", _status_color(status))
    )
    if error:
        row += _c(_RED, "  ✗ " + (error or "").splitlines()[0][:80])
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
