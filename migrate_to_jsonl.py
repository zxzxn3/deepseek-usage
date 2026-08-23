#!/usr/bin/env python3
"""migrate_to_jsonl.py — 一次性迁移：把 usage.db (SQLite) 转成扩展用的 usage.jsonl。

Node 版扩展从 JSONL 读数据（存原始事实，费用在展示层现算），因此只搬运原始字段
（ts/model/tokens/stream/status/error），丢弃 cost/n_messages/input_chars/output_chars。
幂等：按 ts 去重，重复运行不会产生重复记录。

用法：
    python migrate_to_jsonl.py                  # 默认: usage.db → VS Code 扩展 globalStorage
    python migrate_to_jsonl.py --db X --jsonl Y # 自定义路径
"""

import argparse
import json
import os
import sqlite3
import sys


def default_jsonl() -> str:
    # VS Code 扩展 local.deepseek-usage 的 globalStorage
    appdata = os.environ.get("APPDATA", "")
    return os.path.join(
        appdata, "Code", "User", "globalStorage", "local.deepseek-usage", "usage.jsonl"
    )


def existing_ts(jsonl_path: str) -> set:
    if not os.path.exists(jsonl_path):
        return set()
    out = set()
    with open(jsonl_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.add(json.loads(line)["ts"])
            except Exception:
                pass
    return out


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(here, "usage.db"))
    ap.add_argument("--jsonl", default=default_jsonl())
    args = ap.parse_args()

    if not os.path.exists(args.db):
        sys.exit(f"找不到数据库: {args.db}")
    os.makedirs(os.path.dirname(args.jsonl) or ".", exist_ok=True)

    seen = existing_ts(args.jsonl)
    con = sqlite3.connect(args.db)
    rows = con.execute(
        "SELECT ts,model,prompt_tokens,completion_tokens,total_tokens,"
        "cache_hit_tokens,cache_miss_tokens,stream,status,error "
        "FROM usage_log ORDER BY id ASC"
    ).fetchall()
    con.close()

    migrated = skipped = 0
    with open(args.jsonl, "a", encoding="utf-8") as f:
        for ts, model, pt, ct, tt, ch, cm, st, status, err in rows:
            if ts in seen:
                skipped += 1
                continue
            rec = {
                "ts": ts,
                "model": model,
                "prompt_tokens": pt,
                "completion_tokens": ct,
                "total_tokens": tt,
                "cache_hit_tokens": ch,
                "cache_miss_tokens": cm,
                "stream": bool(st),
                "status": status,
                "error": err,
            }
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            migrated += 1
            seen.add(ts)

    print(f"迁移完成: 新增 {migrated} 条, 跳过(已存在) {skipped} 条")
    print(f"  DB   : {args.db}")
    print(f"  JSONL: {args.jsonl}")


if __name__ == "__main__":
    main()
