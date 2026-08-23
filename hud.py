#!/usr/bin/env python3
"""hud.py — 浮动 HUD：永远置顶小窗，实时显示 DeepSeek 用量。

读取同目录 usage.db，每 2 秒刷新：
- 最近一次请求：p/c/t/cH + 费用
- 累计：请求数 / 总token / 总费用 / 缓存节省（约）

用法：
    python hud.py

交互：
- 拖拽移动窗口
- 点右上 ✕ 或右键 → 退出
依赖：仅标准库 tkinter（Windows 自带）。
"""

import os
import sqlite3
import sys
import tkinter as tk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pricing import PRICING, DEFAULT_MODEL  # noqa: E402

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "usage.db")
POLL_MS = 2000  # 刷新间隔（毫秒）

# 配色（深色）
BG = "#1e1e1e"
FG = "#d4d4d4"
DIM = "#8a8a8a"
ACCENT = "#55a868"


def _fmt_tok(n):
    """token 数压缩显示：>=1000 显示 k。"""
    if n is None:
        return "-"
    return f"{n / 1000:.0f}k" if n >= 1000 else str(n)


def _read_snapshot():
    """读 usage.db，返回 (最近一行, 累计聚合)。库不存在/无记录时返回 (None, None)。"""
    if not os.path.exists(DB_PATH):
        return None, None
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA journal_mode=WAL")
    last = con.execute(
        "SELECT ts,model,prompt_tokens,completion_tokens,total_tokens,"
        "cache_hit_tokens,cost,status FROM usage_log ORDER BY id DESC LIMIT 1"
    ).fetchone()
    agg = con.execute(
        "SELECT COUNT(*), COALESCE(SUM(total_tokens),0), COALESCE(SUM(cost),0),"
        " COALESCE(SUM(cache_hit_tokens),0)"
        " FROM usage_log WHERE status=200 AND cost IS NOT NULL"
    ).fetchone()
    con.close()
    return last, agg


class Hud:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("DeepSeek usage")
        self.root.overrideredirect(True)  # 无边框
        self.root.attributes("-topmost", True)  # 永远置顶
        self.root.attributes("-alpha", 0.94)  # 半透明
        self.root.configure(bg=BG)
        self._make_ui()
        self._place_top_right()
        self._bind_drag()

    # ---------- UI ----------
    def _make_ui(self):
        self.title_lbl = tk.Label(
            self.root,
            text="DeepSeek usage",
            bg=BG,
            fg=ACCENT,
            font=("Consolas", 10, "bold"),
            anchor="w",
        )
        self.close_lbl = tk.Label(
            self.root,
            text=" ✕",
            bg=BG,
            fg=DIM,
            font=("Segoe UI", 10),
            cursor="hand2",
        )
        self.close_lbl.bind("<Button-1>", lambda e: self._quit())
        self.title_lbl.grid(row=0, column=0, sticky="w", padx=6)
        self.close_lbl.grid(row=0, column=1, sticky="e", padx=(0, 4))

        self.last_lbl = tk.Label(
            self.root,
            text="等待请求…",
            bg=BG,
            fg=FG,
            font=("Consolas", 9),
            justify="left",
            anchor="w",
        )
        self.last_lbl.grid(row=1, column=0, columnspan=2, sticky="w", padx=6)

        self.tot_lbl = tk.Label(
            self.root,
            text="— 累计 —",
            bg=BG,
            fg=DIM,
            font=("Consolas", 9),
            justify="left",
            anchor="w",
        )
        self.tot_lbl.grid(
            row=2, column=0, columnspan=2, sticky="w", padx=6, pady=(0, 4)
        )

        # 右键退出
        for w in (self.root, self.title_lbl, self.last_lbl, self.tot_lbl):
            w.bind("<Button-3>", lambda e: self._quit())

    def _place_top_right(self):
        sw = self.root.winfo_screenwidth()
        self.root.geometry(f"+{sw - 330 - 16}+16")  # 右上角

    # ---------- 拖拽 ----------
    def _bind_drag(self):
        for w in (self.root, self.title_lbl, self.last_lbl, self.tot_lbl):
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
        last, agg = _read_snapshot()
        if last:
            ts, model, pt, ct, tt, ch, cost, status = last
            ts_s = ts[11:19] if ts else "--"
            p = PRICING.get(model, PRICING[DEFAULT_MODEL])
            cost_s = "-" if cost is None else f"￥{cost:.4f}"
            ch_s = "-" if ch is None else f"￥{ch * p['cache_hit'] / 1e6:.4f}"
            self.last_lbl.config(
                text=f"[{ts_s}] {model}\n"
                f"p {_fmt_tok(pt)} c {_fmt_tok(ct)} t {_fmt_tok(tt)}({cost_s})\n"
                f"cH {_fmt_tok(ch)}({ch_s}) | s {status}"
            )
        if agg:
            n, tok, cost, chit = agg
            # 缓存节省 ≈ 命中token × (未命中价 − 命中价)，用 flash 价近似
            save = (
                chit
                * (
                    PRICING[DEFAULT_MODEL]["cache_miss"]
                    - PRICING[DEFAULT_MODEL]["cache_hit"]
                )
                / 1e6
            )
            self.tot_lbl.config(
                text=f"请求 {n} | token {_fmt_tok(tok)} | ￥{cost:.2f} | 省≈￥{save:.2f}"
            )
        self.root.after(POLL_MS, self._poll)

    def _quit(self):
        self.root.destroy()

    def run(self):
        self._poll()
        self.root.mainloop()


if __name__ == "__main__":
    Hud().run()
