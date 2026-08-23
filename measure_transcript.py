#!/usr/bin/env python3
"""measure_transcript.py — 统计 Copilot 聊天转录 / 任意文本的 token 数。

优先用真实 tokenizer 精确计数；找不到时回退到启发式估算。
支持多种 tokenizer（--tokenizer）：
  - tokenizer.json 路径（任意 HuggingFace/tokenizers BPE 模型，如 DeepSeek）
  - tiktoken 编码名（OpenAI 系：o200k_base / cl100k_base / p50k_base / r50k_base）
默认自动查找 DeepSeek tokenizer.json（环境变量 DEEPSEEK_TOKENIZER 可覆盖）。

用法:
    python measure_transcript.py <transcript.jsonl> [--tokenizer spec] [--turns N]
    python measure_transcript.py --text "要统计的文本" [--tokenizer spec]

参数:
    --tokenizer   tokenizer.json 路径 或 tiktoken 编码名
    --turns N     额外打印最近 N 轮 user/assistant 的 token 数
    --text        直接统计这段文本，不读转录

依赖: pip install tokenizers / tiktoken（精确模式）。未装时自动用字符估算。
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]")
TIKTOKEN_NAMES = ("o200k_base", "cl100k_base", "p50k_base", "r50k_base")


def discover_tokenizer():
    """自动查找 DeepSeek tokenizer.json；可用环境变量 DEEPSEEK_TOKENIZER 覆盖。"""
    env = os.environ.get("DEEPSEEK_TOKENIZER")
    if env and os.path.isfile(env):
        return env
    candidates = [
        r"d:\deepseek_v3_tokenizer\tokenizer.json",
        str(Path(__file__).resolve().parent / "tokenizer.json"),
        str(Path.home() / "deepseek_v3_tokenizer" / "tokenizer.json"),
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


DEFAULT_TOKENIZER = discover_tokenizer()


def load_tokenizer(spec):
    """按 spec 加载 tokenizer，返回 (kind, obj) 或 None（回退启发式）。
    spec 可以是 tiktoken 编码名，或 tokenizer.json 路径。"""
    if not spec:
        return None
    if spec.lower() in TIKTOKEN_NAMES:
        try:
            import tiktoken

            return ("tiktoken", tiktoken.get_encoding(spec))
        except Exception as e:
            print(
                f"[提示] 无法加载 tiktoken 编码 {spec}: {e}（可 pip install tiktoken）",
                file=sys.stderr,
            )
            return None
    try:
        from tokenizers import Tokenizer

        return ("tokenizers", Tokenizer.from_file(spec))
    except Exception as e:
        print(
            f"[提示] 无法加载 tokenizer {spec}: {e}；回退到字符估算。", file=sys.stderr
        )
        return None


def count_tokens(tok, text):
    if tok is not None:
        _kind, obj = tok
        enc = obj.encode(text)
        return len(enc) if isinstance(enc, (list, tuple)) else len(enc.ids)
    cjk = len(CJK_RE.findall(text))
    return cjk + (len(text) - cjk) / 4.0


def split_event(line):
    """返回 (role, content_text)。适配 Copilot 转录事件流格式：
    {type, data:{content, ...}}，type ∈ user.message / assistant.message / ..."""
    try:
        obj = json.loads(line)
    except Exception:
        return None, ""
    etype = obj.get("type", "")
    data = obj.get("data") or {}
    content = data.get("content", "")
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, dict):
                parts.append(c.get("text", "") or c.get("content", "") or "")
            else:
                parts.append(str(c))
        content = "".join(parts)
    content = str(content)
    if etype == "user.message":
        return "user", content
    if etype == "assistant.message":
        extra = ""
        for tr in data.get("toolRequests") or []:
            if isinstance(tr, dict):
                extra += " " + str(tr.get("name", "")) + " " + str(tr.get("args", ""))
        return "assistant", content + extra
    if etype in ("tool.execution_start", "tool.execution_complete"):
        return "tool", json.dumps(data, ensure_ascii=False)
    return etype, content


def run_text(text, tok):
    n = count_tokens(tok, text)
    mode = "精确" if tok is not None else "估算"
    print(f"文本长度 : {len(text):,} 字符")
    print(
        f"token 数 : {n:,.0f}（{mode}；{'真实 tokenizer' if tok is not None else '启发式'}）"
    )
    if tok is not None and "｜User｜" not in text:
        print("注: 不含角色标签/BOS，仅原文；接口侧会额外计 format 开销。")


def run_transcript(path, tok, turns, ctx=0):
    roles = {}
    total_chars = 0
    total_toks = 0.0
    n_events = 0
    last_turns = []  # (role, toks, chars, preview)
    user_ctx = []  # (累计前总token, 本条user token, 预览)
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            n_events += 1
            role, content = split_event(line)
            d = roles.setdefault(role, {"chars": 0, "toks": 0.0})
            t = count_tokens(tok, content)
            d["chars"] += len(content)
            d["toks"] += t
            if role == "user":
                user_ctx.append((total_toks, t, content.replace("\n", " ")[:50]))
            total_chars += len(content)
            total_toks += t
            if role in ("user", "assistant"):
                last_turns.append((role, t, len(content), content))

    mode = "精确" if tok is not None else "估算"
    print(f"转录文件 : {path}")
    print(f"事件条数 : {n_events}")
    for role in ("user", "assistant", "tool"):
        d = roles.get(role)
        if d:
            print(f"  {role:<9}: {d['chars']:>9,} 字符 | {d['toks']:>9,.0f} token")
    print(f"合计     : {total_chars:>9,} 字符 | {total_toks:>9,.0f} token（{mode}）")
    print(
        "注: 仅转录正文；真实每请求还含注入上下文（系统提示/工具 schema/技能清单等）。"
    )

    if ctx > 0:
        print(f"\n每轮 user 消息时的累计上下文（转录部分，精确）：")
        print(f"{'#':>4}{'user_tok':>9}{'累计ctx_tok':>12}  用户消息预览")
        for i, (cum, utok, preview) in enumerate(user_ctx[-ctx:], 1):
            print(f"{i:>4}{utok:>9,}{cum:>12,}  {preview}")

    if turns > 0 and last_turns:
        print(f"\n最近 {min(turns, len(last_turns))} 轮：")
        print(f"{'角色':<10}{'token':>9}{'字符':>9}  内容预览")
        for role, t, ch, content in last_turns[-turns:]:
            preview = content.replace("\n", " ")[:70]
            print(f"{role:<10}{t:>9,.0f}{ch:>9,}  {preview}")


def main():
    ap = argparse.ArgumentParser(
        description="token 计数：转录 / 任意文本（优先真实 tokenizer）"
    )
    ap.add_argument("transcript", nargs="?", help="Copilot 转录 .jsonl 路径")
    ap.add_argument(
        "--tokenizer",
        default=DEFAULT_TOKENIZER,
        help="tokenizer.json 路径 或 tiktoken 编码名（如 o200k_base/cl100k_base）",
    )
    ap.add_argument(
        "--turns", type=int, default=0, help="打印最近 N 轮 user/assistant 的 token"
    )
    ap.add_argument(
        "--ctx",
        type=int,
        default=0,
        help="打印最近 N 轮 user 消息时的累计上下文 token（转录部分）",
    )
    ap.add_argument("--text", help="直接统计这段文本（不读转录）")
    args = ap.parse_args()

    tok = load_tokenizer(args.tokenizer)
    if args.text is not None:
        run_text(args.text, tok)
        return
    if not args.transcript:
        ap.error("需要提供 transcript 路径或 --text")
    run_transcript(args.transcript, tok, args.turns, args.ctx)


if __name__ == "__main__":
    main()
