#!/usr/bin/env python3
"""update_usage_table.py — 扫描本地 Copilot 转录，用真实 DeepSeek tokenizer
统计每个会话的 token 消耗，更新持久化表（SQLite）并打印汇总。

每次运行都会重算所有本地会话（活会话会持续增长，所以不跳过），
结果按 session_id upsert 进 usage_sessions.db；还可选输出图表。

用法:
    python update_usage_table.py [--dir <transcripts目录>] [--db <path>] [--chart] [--top N]
                                  [--model deepseek-v4-flash] [--peak]
（费用按真实 tokenizer 统计结果 × 官方定价估算；--chart 输出带时间戳的图表，不会覆盖旧图）

默认转录目录: 自动识别（%APPDATA%\\Code\\User\\workspaceStorage 下带 transcripts 的目录，不写死用户名）
默认数据库  : token_usage/usage_sessions.db
依赖        : tokenizers / tiktoken（精确模式）；未装则回退字符估算
"""

import argparse
import glob
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from measure_transcript import (
    DEFAULT_TOKENIZER,
    count_tokens,
    load_tokenizer,
    split_event,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "usage_sessions.db")
CHART_DIR = os.path.join(BASE_DIR, "charts")


def discover_transcripts_dir():
    """自动定位 VS Code Copilot 转录目录（不写死用户名）。"""
    roots = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        roots.append(Path(appdata) / "Code" / "User" / "workspaceStorage")
    roots.append(
        Path.home() / "AppData" / "Roaming" / "Code" / "User" / "workspaceStorage"
    )
    best, best_score = None, -1
    for root in roots:
        if not root.is_dir():
            continue
        for ws in root.iterdir():
            p = ws / "GitHub.copilot-chat" / "transcripts"
            if p.is_dir():
                n = len(list(p.glob("*.jsonl")))
                if n > best_score:
                    best, best_score = p, n
    return str(best) if best else None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# 价格：元 / 百万 tokens（2026-08，https://api-docs.deepseek.com/zh-cn/quick_start/pricing/）
# 空闲价 = 高峰价一半；此处为空闲价，--peak 时整体 ×2。
PRICING = {
    "deepseek-v4-flash": {"cache_hit": 0.05, "cache_miss": 1.5, "output": 4.5},
    "deepseek-v4-pro": {"cache_hit": 0.15, "cache_miss": 4.5, "output": 13.5},
    "deepseek-v4-flash-vision-exp": {
        "cache_hit": 0.05,
        "cache_miss": 1.5,
        "output": 4.5,
    },
}
DEFAULT_MODEL = "deepseek-v4-flash"


def compute_cost(m, model, peak=False):
    """按转录角色近似估算费用：user+tool≈输入，assistant≈输出。
    返回 (无缓存·上限, 全缓存命中·下限) 元。"""
    p = PRICING.get(model, PRICING[DEFAULT_MODEL])
    factor = 2.0 if peak else 1.0
    inp = m["user_tok"] + m["tool_tok"]
    out = m["assistant_tok"]
    nocache = (inp * p["cache_miss"] + out * p["output"]) / 1e6 * factor
    allcache = (inp * p["cache_hit"] + out * p["output"]) / 1e6 * factor
    return nocache, allcache


def ensure_columns(con, decls):
    existing = {r[1] for r in con.execute("PRAGMA table_info(session_usage)")}
    for name, decl in decls.items():
        if name not in existing:
            con.execute(f"ALTER TABLE session_usage ADD COLUMN {name} {decl}")


def measure_file(path, tok):
    """统计单个转录文件，返回 dict。"""
    roles = {"user": 0.0, "assistant": 0.0, "tool": 0.0}
    n_events = 0
    ts_first = ts_last = None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            n_events += 1
            ts = obj.get("timestamp")
            if ts:
                ts_first = ts_first or ts
                ts_last = ts
            role, content = split_event(line)
            if role in roles:
                roles[role] += count_tokens(tok, content)
    total = sum(roles.values())
    return {
        "n_events": n_events,
        "first_ts": ts_first,
        "last_ts": ts_last,
        "user_tok": roles["user"],
        "assistant_tok": roles["assistant"],
        "tool_tok": roles["tool"],
        "total_tok": total,
    }


def main():
    ap = argparse.ArgumentParser(
        description="扫描本地 Copilot 转录，更新 token 消耗表（SQLite）"
    )
    ap.add_argument(
        "--dir", default=None, help="transcripts 目录（默认自动识别，不写死用户名）"
    )
    ap.add_argument(
        "--tokenizer", default=DEFAULT_TOKENIZER, help="tokenizer.json 路径"
    )
    ap.add_argument("--db", default=DB_PATH, help="SQLite 输出路径")
    ap.add_argument(
        "--model", default=DEFAULT_MODEL, help="计费模型（默认 deepseek-v4-flash）"
    )
    ap.add_argument("--peak", action="store_true", help="按高峰价计费（默认空闲价）")
    ap.add_argument("--chart", action="store_true", help="生成带时间戳的图表 charts/")
    ap.add_argument("--top", type=int, default=0, help="只显示前 N 大会话（0=全部）")
    args = ap.parse_args()

    dir_path = args.dir or discover_transcripts_dir()
    if not dir_path:
        sys.exit("未找到 Copilot 转录目录，请用 --dir 指定。")

    tok = load_tokenizer(args.tokenizer)
    mode = "精确" if tok is not None else "估算"

    if not os.path.isdir(dir_path):
        sys.exit(f"转录目录不存在: {dir_path}")

    con = sqlite3.connect(args.db)
    con.execute("""
        CREATE TABLE IF NOT EXISTS session_usage(
            session_id   TEXT PRIMARY KEY,
            file         TEXT,
            first_ts     TEXT,
            last_ts      TEXT,
            n_events     INTEGER,
            user_tok     REAL,
            assistant_tok REAL,
            tool_tok     REAL,
            total_tok    REAL,
            measured_at  TEXT
        )
        """)
    ensure_columns(
        con,
        {
            "model": "TEXT",
            "cost_nocache": "REAL",
            "cost_allcache": "REAL",
        },
    )

    files = sorted(glob.glob(os.path.join(dir_path, "*.jsonl")))
    rows = []
    for f in files:
        sid = os.path.splitext(os.path.basename(f))[0]
        m = measure_file(f, tok)
        nocache, allcache = compute_cost(m, args.model, peak=args.peak)
        m["cost_nocache"] = nocache
        m["cost_allcache"] = allcache
        con.execute(
            "INSERT OR REPLACE INTO session_usage(session_id,file,first_ts,last_ts,"
            "n_events,user_tok,assistant_tok,tool_tok,total_tok,model,"
            "cost_nocache,cost_allcache,measured_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                sid,
                os.path.basename(f),
                m["first_ts"],
                m["last_ts"],
                m["n_events"],
                m["user_tok"],
                m["assistant_tok"],
                m["tool_tok"],
                m["total_tok"],
                args.model,
                nocache,
                allcache,
                now_iso(),
            ),
        )
        rows.append((sid, m))
    con.commit()

    # 按 last_ts 排序（新的在前）
    rows.sort(key=lambda r: r[1]["last_ts"] or "", reverse=True)
    if args.top > 0:
        rows = rows[: args.top]

    grand = {
        "user_tok": 0.0,
        "assistant_tok": 0.0,
        "tool_tok": 0.0,
        "total_tok": 0.0,
        "cost_nocache": 0.0,
        "cost_allcache": 0.0,
    }
    price_note = "高峰价" if args.peak else "空闲价"
    print(f"转录目录 : {dir_path}")
    print(f"会话数量 : {len(files)}  | 统计方式: {mode}")
    print(f"计费模型 : {args.model}  | 价格: {price_note}")
    print(f"费用列: ↑=无缓存(上限)  ↓=全缓存命中(下限)，单位 元")
    print(f"数据库   : {args.db}\n")
    hdr = (
        f"{'会话':<14}{'最后活动':<17}{'事件':>6}{'user':>8}{'asst':>9}"
        f"{'tool':>9}{'合计':>9}{'费用↑':>9}{'费用↓':>9}"
    )
    print(hdr)
    print("-" * len(hdr))
    for sid, m in rows:
        last = (m["last_ts"] or "")[:16]
        print(
            f"{sid[:14]:<14}{last:<17}{m['n_events']:>6}"
            f"{m['user_tok']:>8,.0f}{m['assistant_tok']:>9,.0f}"
            f"{m['tool_tok']:>9,.0f}{m['total_tok']:>9,.0f}"
            f"{m['cost_nocache']:>9,.2f}{m['cost_allcache']:>9,.2f}"
        )
        for k in grand:
            grand[k] += m[k]
    print("-" * len(hdr))
    print(
        f"{'合计':<14}{'':<17}{'':>6}"
        f"{grand['user_tok']:>8,.0f}{grand['assistant_tok']:>9,.0f}"
        f"{grand['tool_tok']:>9,.0f}{grand['total_tok']:>9,.0f}"
        f"{grand['cost_nocache']:>9,.2f}{grand['cost_allcache']:>9,.2f}"
    )
    con.close()

    if args.chart:
        try:
            import matplotlib

            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
            from matplotlib import font_manager
        except ImportError:
            print("未安装 matplotlib，跳过图表。")
            return
        for name in ("Microsoft YaHei", "SimHei", "PingFang SC"):
            if any(
                name.lower() in f.name.lower() for f in font_manager.fontManager.ttflist
            ):
                plt.rcParams["font.sans-serif"] = [name]
                break
        plt.rcParams["axes.unicode_minus"] = False

        rows_c = sorted(rows, key=lambda r: r[1]["last_ts"] or "")
        labels = [r[0][:14] for r in rows_c]
        u = [r[1]["user_tok"] for r in rows_c]
        a = [r[1]["assistant_tok"] for r in rows_c]
        t = [r[1]["tool_tok"] for r in rows_c]
        cn = [r[1]["cost_nocache"] for r in rows_c]

        fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11, 7))
        x = range(len(rows_c))
        ax1.bar(x, u, label="user", color="#55A868")
        ax1.bar(x, a, bottom=u, label="assistant", color="#4C72B0")
        ax1.bar(
            x,
            t,
            bottom=[u[i] + a[i] for i in range(len(rows_c))],
            label="tool",
            color="#DD8452",
        )
        ax1.set_ylabel("tokens")
        ax1.set_title("各会话 token 消耗（真实 DeepSeek tokenizer）")
        ax1.legend()
        ax2.bar(x, cn, color="#C44E52", label=f"费用(无缓存, {price_note}) 元")
        ax2.set_ylabel("元")
        ax2.set_xlabel("会话")
        ax2.legend()
        for axx in (ax1, ax2):
            axx.set_xticks(list(x))
            axx.set_xticklabels(labels, rotation=45, ha="right")
        fig.tight_layout()
        os.makedirs(CHART_DIR, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        out = os.path.join(CHART_DIR, f"sessions_{ts}.png")
        fig.savefig(out, dpi=150)
        print(f"\n图表已保存: {out}（带时间戳，不会覆盖旧图）")


if __name__ == "__main__":
    main()
