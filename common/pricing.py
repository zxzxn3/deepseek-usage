"""common/pricing.py — 官方定价表与费用计算（路1 估算 / 路2 精确 共用）。

价格来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/（2026-08）
- 高峰价 = 空闲价 × 2；高峰 = 北京时间周一~五 9:00-12:00、14:00-18:00。
- 单位：元 / 百万 tokens。

用法：
  路1（转录估算）：cost_from_roles(user_tok, tool_tok, assistant_tok, peak_ratio)
  路2（精确 usage）：cost_from_usage(prompt_tokens, completion_tokens, cache_hit, cache_miss)
"""

# 模型 → 空闲价 {cache_hit: 输入缓存命中, cache_miss: 输入未命中, output: 输出}
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


def _factor(pricing_mode: str, peak_ratio: float = 0.0) -> float:
    """价格系数：peak=×2 / offpeak=×1 / auto=1+peak_ratio。"""
    if pricing_mode == "peak":
        return 2.0
    if pricing_mode == "offpeak":
        return 1.0
    return 1.0 + peak_ratio  # auto：高峰占比 f → 综合系数 1+f（0.5 高峰 → 1.5）


def cost_from_roles(
    user_tok,
    tool_tok,
    assistant_tok,
    peak_ratio=0.0,
    model=DEFAULT_MODEL,
    pricing="auto",
):
    """路1（转录估算）：输入≈user+tool，输出≈assistant。
    返回 (无缓存·上限, 全缓存命中·下限) 元。"""
    p = PRICING.get(model, PRICING[DEFAULT_MODEL])
    f = _factor(pricing, peak_ratio)
    inp = user_tok + tool_tok
    out = assistant_tok
    nocache = (inp * p["cache_miss"] + out * p["output"]) / 1e6 * f
    allcache = (inp * p["cache_hit"] + out * p["output"]) / 1e6 * f
    return nocache, allcache


def cost_from_usage(
    prompt_tokens,
    completion_tokens,
    cache_hit_tokens,
    cache_miss_tokens,
    model=DEFAULT_MODEL,
    peak=False,
):
    """路2（精确 usage）：输入=缓存命中+未命中分开计价，输出按 output 价。
    返回本次请求费用（元）。"""
    p = PRICING.get(model, PRICING[DEFAULT_MODEL])
    f = 2.0 if peak else 1.0
    total = (
        (
            cache_miss_tokens * p["cache_miss"]
            + cache_hit_tokens * p["cache_hit"]
            + completion_tokens * p["output"]
        )
        / 1e6
        * f
    )
    return total
