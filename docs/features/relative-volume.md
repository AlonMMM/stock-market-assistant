# Relative volume v1

Approved: US stocks, extended hours, minute-close evaluation, same-time volume anomaly as the first feature. Opening/closing minutes remain eligible when unusual for their own time of day (implementation assumption from the user's yes).

Defaults: rolling 5-minute volume divided by the median of the matching window over 20 previous observed session dates; threshold >= 3; 15-minute cooldown. Require a fresh below-to-above crossing after cooldown. A sustained spike is not alerted repeatedly. Session/date boundaries reset crossing state. Minimum window volume 10,000 shares is a configurable provisional liquidity filter, not a validated trading threshold.

Only contiguous closed bars within one session/date count. Warmup windows return no evaluation. Missing matching historical windows produce insufficient-history; zero medians produce zero-baseline. No older dates are substituted for missing windows. Entirely absent dates cannot be detected without a provider calendar and must be rejected/flagged by the future ingestion adapter. Replay is signal reconstruction, not a profitability backtest.

## Input contract

POST /api/replay with `{ "config": { "threshold": 3 }, "bars": [...] }`. Omit bars for a labeled synthetic demo. Config also accepts window, days, cooldown, minVolume. Response contains alerts with rule/config evidence and diagnostic counts. Upload size is bounded by Fastify's body limit (1 MiB); this is an in-memory prototype.

Each bar: `{ "ticker": "NVDA", "end": "2026-03-30T15:20:00.000Z", "date": "2026-03-30", "minute": 680, "session": "regular", "volume": 10000 }`.

end is the UTC close timestamp, date and minute are the New York session date and local end-minute. The adapter supplies calendar-verified pre/regular/post labels and only finalized bars. Early closes, holidays, adjustments and missing full sessions need provider normalization. Duplicate or out-of-order streaming bars are rejected. Replay sorts input by event time. Only earlier dates contribute to the baseline.

## Current delivery

Deterministic streaming engine, JSON historical replay API, website demo/upload and ratio/liquidity controls. No live provider, database, price/sector charts or phone delivery yet. Historical input must contain its warmup history. The demo contains 21 synthetic weekdays with a single NVDA anomaly and accounts for March DST.
