#!/usr/bin/env python3
"""path1/scan.py — 路1（估算）：读 Copilot 转录 → tokenizer 数 token → 估算费用 → 写 usage_sessions.db。

- 增量：按 文件大小+修改时间 只重算变化的会话；schema 版本变了才删库重建一次。
- 报告/图表已移出（暂时不做），只保留核心管线 + 一行摘要。
- 费用用 common/pricing（与路2 共用同一份定价表）。

用法:
    python scan.py [--dir <transcripts目录>] [--db <path>] [--model deepseek-v4-flash]
                   [--pricing auto|offpeak|peak] [--watch N]

默认转录目录: 自动识别全部工作区（%APPDATA%\\Code\\User\\workspaceStorage 下所有 transcripts）
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

# 允许直接 `python path1_transcript/scan.py` 运行：把 token_usage 根加入 sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from common.pricing import DEFAULT_MODEL, cost_from_roles  # noqa: E402
from measure import (
    DEFAULT_TOKENIZER,
    count_tokens,
    load_tokenizer,
    split_event,
)  # noqa: E402

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "usage_sessions.db")

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
            # 需要（重）算：measure_file 统计 + 共用定价估算费用
            m = measure_file(f, tok)
            nocache, allcache = cost_from_roles(
                m["user_tok"],
                m["tool_tok"],
                m["assistant_tok"],
                peak_ratio=m["peak_ratio"],
                model=args.model,
                pricing=args.pricing,
            )
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

    # 汇总（用 SQL 聚合，报告/图表暂时不做）
    n, total_tok, cost_hi, cost_lo = con.execute(
        "SELECT COUNT(*), COALESCE(SUM(total_tok),0),"
        " COALESCE(SUM(cost_nocache),0), COALESCE(SUM(cost_allcache),0)"
        " FROM session_usage"
    ).fetchone()
    con.close()

    if compact:
        print(
            f"[{datetime.now().strftime('%H:%M:%S')}] 工作区 {len(dirs)} | 会话 {n}"
            f" | 总token {total_tok:,.0f}"
            f" | 费用 ¥{cost_hi:.2f}↑/¥{cost_lo:.2f}↓ | 重算{n_changed}"
        )
    else:
        print(f"转录目录 : {len(dirs)} 个工作区 | 统计方式: {mode}")
        print(f"数据库   : {args.db}")
        print(
            f"会话 {n} 个（本次重算 {n_changed}）| 总token {total_tok:,.0f}"
            f" | 费用 ¥{cost_hi:.2f}↑/¥{cost_lo:.2f}↓"
        )


def main():
    ap = argparse.ArgumentParser(
        description="路1（估算）：读转录 → token 数 → 估算费用 → 写 usage_sessions.db"
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
