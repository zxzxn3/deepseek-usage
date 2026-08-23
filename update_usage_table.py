#!/usr/bin/env python3
"""update_usage_table.py — 扫描本地 Copilot 转录，用真实 DeepSeek tokenizer
统计每个会话的 token 消耗，更新持久化表（SQLite）并打印汇总。

每次运行默认复用数据库：只按文件大小/修改时间增量重算变化的会话（活会话每次都会更新），
其余用缓存；仅当表结构版本（SCHEMA_VERSION）变更时才删库重建一次。
结果按 session_id upsert 进 usage_sessions.db；还可选输出图表。

用法:
    python update_usage_table.py [--dir <transcripts目录>] [--db <path>] [--chart] [--top N]
                                  [--model deepseek-v4-flash] [--pricing auto|offpeak|peak]
                                  [--watch N]
（费用按真实 tokenizer 统计结果 × 官方定价估算；--pricing 默认 auto，按事件时间自动算高峰/空闲；
 --chart 输出带时间戳的图表；--watch N 监听模式每 N 秒重扫更新，Ctrl+C 退出）

默认转录目录: 自动识别全部工作区（%APPDATA%\\Code\\User\\workspaceStorage 下所有 transcripts，
              不写死用户名）；排序 = 工作区修改时间新→旧，再按各会话时间新→旧
默认数据库  : token_usage/usage_sessions.db
依赖        : tokenizers / tiktoken（精确模式）；未装则回退字符估算
"""

import argparse
import glob
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timedelta, timezone
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

# 表结构版本号：改了表结构就 +1 → 触发一次删库重建；格式稳定后保持不变 → 复用库只增量更新
SCHEMA_VERSION = 1


def discover_transcripts_dirs():
    """返回全部工作区的转录目录 [(dir, 工作区名, 目录mtime)]，按 mtime 新→旧。

    思路：VS Code 把每个工作区的聊天数据放在
      %APPDATA%\\Code\\User\\workspaceStorage\\<工作区hash>\\GitHub.copilot-chat\\transcripts\\
    我们扫遍所有工作区 hash，把它们全部收集起来（不只挑一个）。
    """
    found = {}  # key=目录绝对路径（去重），value=(路径, 工作区名, 目录mtime)
    roots = []
    appdata = os.environ.get("APPDATA")  # 通常 C:\\Users\\<用户名>\\AppData\\Roaming
    if appdata:
        roots.append(Path(appdata) / "Code" / "User" / "workspaceStorage")
    roots.append(
        Path.home() / "AppData" / "Roaming" / "Code" / "User" / "workspaceStorage"
    )
    # 上面两个入口在 Windows 上多半是同一个路径；同时保留是为了兼容其他环境
    for root in roots:
        if not root.is_dir():
            continue
        for ws in root.iterdir():  # ws = 每个工作区 hash 目录，如 c9ef11c6...
            p = ws / "GitHub.copilot-chat" / "transcripts"
            if p.is_dir():
                try:
                    mt = p.stat().st_mtime  # 目录最后修改时间 = 最近活跃度
                except OSError:
                    mt = 0.0
                found[str(p.resolve())] = (str(p), ws.name, mt)
    # 按 mtime 从新到旧排序 → 最新活跃的工作区排最前
    return sorted(found.values(), key=lambda t: t[2], reverse=True)


def _is_peak(ts):
    """判断某事件时间戳是否落在"高峰时段"。

    DeepSeek 定价的高峰 = 北京时间周一~五 9:00-12:00、14:00-18:00（其余空闲，价格减半）。
    转录里的时间戳是 UTC，所以先 +8 小时换算成北京时间再判断。
    """
    try:
        t = datetime.fromisoformat(ts.replace("Z", "+00:00"))  # 把 Z 结尾当 UTC
    except Exception:
        return False
    bj = t + timedelta(hours=8)  # UTC → 北京时间
    if bj.weekday() >= 5:  # 周六日 = 空闲
        return False
    return (9 <= bj.hour < 12) or (14 <= bj.hour < 18)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# 价格：元 / 百万 tokens（2026-08，https://api-docs.deepseek.com/zh-cn/quick_start/pricing/）
# 空闲价 = 高峰价一半；此处为空闲价，--pricing peak 时整体 ×2。
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


def compute_cost(m, model, pricing="auto"):
    """按转录角色近似估算费用：user+tool≈输入，assistant≈输出。
    pricing: auto(按 m 里 peak_ratio 加权) / offpeak(×1) / peak(×2)。
    返回 (无缓存·上限, 全缓存命中·下限) 元。"""
    p = PRICING.get(model, PRICING[DEFAULT_MODEL])
    # 价格系数：高峰价 = 空闲价 × 2
    if pricing == "peak":
        factor = 2.0
    elif pricing == "offpeak":
        factor = 1.0
    else:  # auto：高峰占比 f → 综合系数 = 1 + f
        # 例如一半事件在高峰(f=0.5) → 系数 1.5，即 0.5×1 + 0.5×2 的加权
        factor = 1.0 + m.get("peak_ratio", 0.0)
    inp = m["user_tok"] + m["tool_tok"]  # 输入 ≈ 你发的 + 工具结果
    out = m["assistant_tok"]  # 输出 ≈ 模型的回复
    # 价格单位是"元/百万 token"，所以除以 1e6
    nocache = (inp * p["cache_miss"] + out * p["output"]) / 1e6 * factor
    allcache = (inp * p["cache_hit"] + out * p["output"]) / 1e6 * factor
    return nocache, allcache  # (最贵, 最便宜) 两个极端，真实值在中间


def measure_file(path, tok):
    """统计单个转录文件，返回 dict（含 peak_ratio = 高峰时段的 token 占比）。

    转录文件是"事件流"：每行一个 JSON 事件（user.message / assistant.message /
    tool.execution_* / turn 标记等）。我们逐行解析、分词、累计。
    """
    roles = {"user": 0.0, "assistant": 0.0, "tool": 0.0}  # 按角色累计 token
    n_events = 0
    total_toks = 0.0  # 全部 token（含无角色事件）
    peak_toks = 0.0  # 其中落在高峰时段的 token
    ts_first = ts_last = None  # 会话首末时间（用于排序/展示）
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            try:
                obj = json.loads(line)  # 每行是一个 JSON 事件
            except Exception:
                continue
            n_events += 1
            ts = obj.get("timestamp")  # UTC ISO 时间戳
            if ts:
                ts_first = ts_first or ts  # 只记第一次
                ts_last = ts  # 每次都覆盖 → 最后是最后一次
            role, content = split_event(line)  # 从事件流里提取 (角色, 文本)
            t = count_tokens(tok, content)  # 用真实 tokenizer 数这段文本
            total_toks += t
            if role in roles:
                roles[role] += t
            if _is_peak(ts):  # 高峰时段的 token 单独累计，用于 auto 计价
                peak_toks += t
    total = sum(roles.values())
    return {
        "n_events": n_events,
        "first_ts": ts_first,
        "last_ts": ts_last,
        "user_tok": roles["user"],
        "assistant_tok": roles["assistant"],
        "tool_tok": roles["tool"],
        "total_tok": total,
        "peak_ratio": (peak_toks / total_toks) if total_toks else 0.0,  # 防除零
    }


def run_scan(args, compact=False):
    """执行一次完整扫描+更新。compact=True 时只打印一行摘要（监听模式）。"""
    if args.dir:
        dirs = [(args.dir, "manual", 0.0)]
    else:
        dirs = discover_transcripts_dirs()
        if not dirs:
            sys.exit("未找到任何 Copilot 转录目录，请用 --dir 指定。")

    tok = load_tokenizer(args.tokenizer)
    mode = "精确" if tok is not None else "估算"

    con = sqlite3.connect(args.db)
    # ---- schema 版本门控：只有格式变更才重建；格式稳定后复用库、只增量更新 ----
    version = con.execute("PRAGMA user_version").fetchone()[0]
    rebuild = version != SCHEMA_VERSION
    if rebuild:
        con.execute("DROP TABLE IF EXISTS session_usage")
        con.execute("""
            CREATE TABLE session_usage(
                session_id   TEXT PRIMARY KEY,
                file         TEXT,
                workspace    TEXT,
                first_ts     TEXT,
                last_ts      TEXT,
                n_events     INTEGER,
                user_tok     REAL,
                assistant_tok REAL,
                tool_tok     REAL,
                total_tok    REAL,
                model        TEXT,
                cost_nocache REAL,
                cost_allcache REAL,
                file_size    INTEGER,
                file_mtime   REAL,
                measured_at  TEXT
            )
            """)
        con.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        con.commit()
        print(f"[schema] 库版本 {version} → {SCHEMA_VERSION}，已重建（格式变更）")

    # ---- 增量扫描：只重算"文件变了"的会话（用 大小+修改时间 判断缓存命中）----
    seen = set()
    n_changed = 0
    for dir_path, ws_name, _mt in dirs:
        if not os.path.isdir(dir_path):
            continue
        for f in sorted(glob.glob(os.path.join(dir_path, "*.jsonl"))):
            sid = os.path.splitext(os.path.basename(f))[0]  # 文件名 = session_id
            seen.add((ws_name, sid))
            try:
                st = os.stat(f)
                fsize, fmtime = st.st_size, st.st_mtime
            except OSError:
                fsize, fmtime = 0, 0.0
            if not rebuild:
                # 缓存命中：文件没变 → 直接沿用库里的旧行
                hit = con.execute(
                    "SELECT 1 FROM session_usage WHERE session_id=? AND file_size=? AND file_mtime=?",
                    (sid, fsize, fmtime),
                ).fetchone()
                if hit:
                    continue
            # 需要（重）算：measure_file 统计 + compute_cost 估费
            m = measure_file(f, tok)
            nocache, allcache = compute_cost(m, args.model, pricing=args.pricing)
            m["cost_nocache"], m["cost_allcache"] = nocache, allcache
            con.execute(
                "INSERT OR REPLACE INTO session_usage(session_id,file,workspace,"
                "first_ts,last_ts,n_events,user_tok,assistant_tok,tool_tok,total_tok,"
                "model,cost_nocache,cost_allcache,file_size,file_mtime,measured_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    sid,
                    os.path.basename(f),
                    ws_name,
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
                    fsize,
                    fmtime,
                    now_iso(),
                ),
            )
            n_changed += 1

    # 清理：转录文件已消失 / 目录不在扫描范围的行（避免越积越多）
    for ws, sid in con.execute("SELECT workspace, session_id FROM session_usage"):
        if (ws, sid) not in seen:
            con.execute(
                "DELETE FROM session_usage WHERE session_id=? AND workspace=?",
                (sid, ws),
            )
    con.commit()

    # 展示用：从库里读全量行（含未变化的缓存行）
    ws_rank = {ws_name: i for i, (_d, ws_name, _m) in enumerate(dirs)}
    rows = [
        (
            ws,
            sid,
            {
                "last_ts": last_ts,
                "n_events": n_events,
                "user_tok": user_tok,
                "assistant_tok": assistant_tok,
                "tool_tok": tool_tok,
                "total_tok": total_tok,
                "cost_nocache": cost_nocache,
                "cost_allcache": cost_allcache,
            },
        )
        for ws, sid, last_ts, n_events, user_tok, assistant_tok, tool_tok, total_tok, cost_nocache, cost_allcache in con.execute(
            "SELECT workspace,session_id,last_ts,n_events,user_tok,assistant_tok,"
            "tool_tok,total_tok,cost_nocache,cost_allcache FROM session_usage"
        )
    ]
    # 排序：先会话时间 新→旧，再按工作区 rank（新→旧）稳定排序保持组内顺序
    rows.sort(key=lambda r: r[2]["last_ts"] or "", reverse=True)
    rows.sort(key=lambda r: ws_rank.get(r[0], len(dirs)))
    con.close()

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
    for _ws, _sid, m in rows:
        for k in grand:
            grand[k] += m[k]

    if args.pricing == "peak":
        price_note = "高峰价"
    elif args.pricing == "offpeak":
        price_note = "空闲价"
    else:
        price_note = "auto(按时间)"

    if compact:
        print(
            f"[{datetime.now().strftime('%H:%M:%S')}] 工作区 {len(dirs)} | 会话 {len(rows)}"
            f" | 总token {grand['total_tok']:,.0f}"
            f" | 费用 ¥{grand['cost_nocache']:.2f}↑/¥{grand['cost_allcache']:.2f}↓"
            f" | 重算{n_changed}"
        )
    else:
        print(f"转录目录 : {', '.join(d[0] for d in dirs)}")
        print(f"会话数量 : {len(rows)}  | 统计方式: {mode}  | 本次重算: {n_changed}")
        print(f"计费模型 : {args.model}  | 价格: {price_note}")
        print(f"费用列: ↑=无缓存(上限)  ↓=全缓存命中(下限)，单位 元")
        print(f"数据库   : {args.db}\n")
        hdr = (
            f"{'工作区':<10}{'会话':<14}{'最后活动':<17}{'事件':>6}{'user':>8}"
            f"{'asst':>9}{'tool':>9}{'合计':>9}{'费用↑':>9}{'费用↓':>9}"
        )
        print(hdr)
        print("-" * len(hdr))
        for ws_name, sid, m in rows:
            last = (m["last_ts"] or "")[:16]
            print(
                f"{ws_name[:9]:<10}{sid[:14]:<14}{last:<17}{m['n_events']:>6}"
                f"{m['user_tok']:>8,.0f}{m['assistant_tok']:>9,.0f}"
                f"{m['tool_tok']:>9,.0f}{m['total_tok']:>9,.0f}"
                f"{m['cost_nocache']:>9,.2f}{m['cost_allcache']:>9,.2f}"
            )
        print("-" * len(hdr))
        print(
            f"{'合计':<10}{'':<14}{'':<17}{'':>6}"
            f"{grand['user_tok']:>8,.0f}{grand['assistant_tok']:>9,.0f}"
            f"{grand['tool_tok']:>9,.0f}{grand['total_tok']:>9,.0f}"
            f"{grand['cost_nocache']:>9,.2f}{grand['cost_allcache']:>9,.2f}"
        )

    if args.chart and not compact:
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

        labels = [f"{ws[:4]}:{sid[:9]}" for ws, sid, _m in rows]
        u = [m["user_tok"] for _w, _s, m in rows]
        a = [m["assistant_tok"] for _w, _s, m in rows]
        t = [m["tool_tok"] for _w, _s, m in rows]
        cn = [m["cost_nocache"] for _w, _s, m in rows]

        fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11, 7))
        x = range(len(rows))
        ax1.bar(x, u, label="user", color="#55A868")
        ax1.bar(x, a, bottom=u, label="assistant", color="#4C72B0")
        ax1.bar(
            x,
            t,
            bottom=[u[i] + a[i] for i in range(len(rows))],
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


def main():
    ap = argparse.ArgumentParser(
        description="扫描本地 Copilot 转录，更新 token 消耗表（SQLite）"
    )
    ap.add_argument(
        "--dir", default=None, help="transcripts 目录（默认自动识别全部工作区）"
    )
    ap.add_argument(
        "--tokenizer", default=DEFAULT_TOKENIZER, help="tokenizer.json 路径"
    )
    ap.add_argument("--db", default=DB_PATH, help="SQLite 输出路径")
    ap.add_argument(
        "--model", default=DEFAULT_MODEL, help="计费模型（默认 deepseek-v4-flash）"
    )
    ap.add_argument(
        "--pricing",
        choices=["auto", "offpeak", "peak"],
        default="auto",
        help="价格时段：auto=按事件时间自动（默认）/ offpeak=一律空闲 / peak=一律高峰",
    )
    ap.add_argument("--chart", action="store_true", help="生成带时间戳的图表 charts/")
    ap.add_argument("--top", type=int, default=0, help="只显示前 N 大会话（0=全部）")
    ap.add_argument(
        "--watch",
        type=int,
        nargs="?",
        const=5,
        default=0,
        metavar="秒",
        help="监听模式：每 N 秒重扫更新，默认 5 秒（Ctrl+C 退出）",
    )
    args = ap.parse_args()

    if args.watch > 0:
        # 监听模式：循环扫描 + 休眠，Ctrl+C 中断退出
        print(f"监听模式：每 {args.watch} 秒更新一次，Ctrl+C 退出。")
        try:
            while True:
                run_scan(args, compact=True)  # compact=True → 只打一行摘要
                time.sleep(args.watch)
        except KeyboardInterrupt:
            print("\n已停止。")
    else:
        run_scan(args, compact=False)


if __name__ == "__main__":
    main()
