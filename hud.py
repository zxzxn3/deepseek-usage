#!/usr/bin/env python3
"""hud.py — 浮动 HUD：屏幕顶部居中，大号显示今天的用量。

读取同目录 usage.db，每 2 秒刷新两行（与 proxy 统计栏同口径：今天/本地时区）：
- 大号：费用 总/缓存命中    ￥4.1963/2.3070
- 小号：token 总/缓存命中   46.33M/44.34M

用法：python hud.py
交互：拖拽移动；右键 → 退出
依赖：仅标准库 tkinter（Windows 自带）+ termfmt/pricing。
"""

import os
import sqlite3
import sys
import tkinter as tk
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pricing import PRICING, DEFAULT_MODEL  # noqa: E402
from termfmt import fmt_num  # noqa: E402

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "usage.db")
POLL_MS = 2000  # 刷新间隔（毫秒）

# 配色（深色）
BG = "#1e1e1e"
MONEY = "#e5c07b"  # 费用：暖黄（与终端费用同语义）
DIM = "#8a8a8a"


def _today_stats():
    """今天（本地时区）的累计，与 proxy._today_stats 同口径。

    返回 (p, c, t, ch, cost, ch_cost)；费用用行内已存 cost 精确求和，
    ch_cost 按各模型命中单价累加。库不存在/无记录时返回全 0。
    """
    if not os.path.exists(DB_PATH):
        return 0, 0, 0, 0, 0.0, 0.0
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA journal_mode=WAL")
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
    p = c = t = ch = 0
    cost = ch_cost = 0.0
    for model, pt, ct, tt, chh, row_cost in rows:
        p += pt or 0
        c += ct or 0
        t += tt or 0
        ch += chh or 0
        cost += row_cost or 0  # NULL（错误/老记录）按 0 兜底
        pr = PRICING.get(model, PRICING[DEFAULT_MODEL])
        ch_cost += (chh or 0) * pr["cache_hit"] / 1e6
    return p, c, t, ch, cost, ch_cost


class Hud:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("DeepSeek usage")
        self.root.overrideredirect(True)  # 无边框
        self.root.attributes("-topmost", True)  # 永远置顶
        self.root.attributes("-alpha", 0.94)  # 半透明
        self.root.configure(bg=BG)
        self._make_ui()
        self._place_top_center()
        self._bind_drag()

    # ---------- UI ----------
    def _make_ui(self):
        # 大号：费用 总/缓存命中；小号：token 总/缓存命中（均居中）
        self.cost_lbl = tk.Label(
            self.root,
            text="￥--/--",
            bg=BG,
            fg=MONEY,
            font=("Consolas", 28, "bold"),
        )
        self.tok_lbl = tk.Label(
            self.root,
            text="--/--",
            bg=BG,
            fg=DIM,
            font=("Consolas", 14),
        )
        self.cost_lbl.pack(padx=18, pady=(10, 0))
        self.tok_lbl.pack(padx=18, pady=(0, 10))
        # 右键退出
        self.root.bind("<Button-3>", lambda e: self._quit())

    def _place_top_center(self):
        self.root.update_idletasks()
        w = self.root.winfo_reqwidth()
        sw = self.root.winfo_screenwidth()
        self.root.geometry(f"+{max(0, (sw - w) // 2)}+8")  # 顶部居中

    # ---------- 拖拽 ----------
    def _bind_drag(self):
        for w in (self.root, self.cost_lbl, self.tok_lbl):
            w.bind("<Button-1>", self._down)
            w.bind("<B1-Motion>", self._move)

    def _down(self, e):
        self._dx, self._dy = e.x, e.y

    def _move(self, e):
        x = self.root.winfo_x() + e.x - self._dx
        y = self.root.winfo_y() + e.y - self._dy
        self.root.geometry(f"+{x}+{y}")

    # ---------- 数据刷新 ----------
    def _poll(self):
        _p, _c, t, ch, cost, ch_cost = _today_stats()
        self.cost_lbl.config(text=f"￥{cost:.4f}/{ch_cost:.4f}")
        self.tok_lbl.config(text=f"{fmt_num(t)}/{fmt_num(ch)}")
        self.root.after(POLL_MS, self._poll)

    def _quit(self):
        self.root.destroy()

    def run(self):
        self._poll()
        self.root.mainloop()


if __name__ == "__main__":
    Hud().run()
