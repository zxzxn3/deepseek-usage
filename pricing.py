"""pricing.py — 官方定价表与费用计算。

价格来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/（2026-08）
- 高峰价 = 空闲价 × 2；高峰 = 北京时间周一~五 9:00-12:00、14:00-18:00。
- 单位：元 / 百万 tokens。

用法：
  精确 usage：cost_from_usage(prompt_tokens, completion_tokens, cache_hit, cache_miss)
"""

from datetime import datetime, timedelta, timezone

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


def is_peak_bt(ts_utc) -> bool:
    """ts_utc（UTC ISO 字符串或 datetime）是否落在北京时间高峰时段。

    高峰 = 北京时间周一~五 9:00-12:00、14:00-18:00；周六日不计。
    中国无夏令时，北京 = UTC+8 固定偏移。
    """
    if isinstance(ts_utc, str):
        dt = datetime.fromisoformat(ts_utc)
    else:
        dt = ts_utc
    if dt.tzinfo is None:  # 无时区按 UTC 处理
        dt = dt.replace(tzinfo=timezone.utc)
    bt = dt + timedelta(hours=8)  # 北京时间
    wd = bt.weekday()  # Mon=0..Sun=6
    h = bt.hour
    if wd >= 5:  # 周六/周日
        return False
    return (9 <= h < 12) or (14 <= h < 18)


def cost_from_usage(
    prompt_tokens,
    completion_tokens,
    cache_hit_tokens,
    cache_miss_tokens,
    model=DEFAULT_MODEL,
    peak=False,
):
    """精确 usage：输入=缓存命中+未命中分开计价，输出按 output 价。
    peak=True 按高峰价 ×2（北京时间高峰时段）。
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
