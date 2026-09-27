# Relative volume

Approved: US stocks, extended hours, minute-close evaluation, same-time volume anomaly as the first feature. Opening/closing minutes remain eligible when unusual for their own time of day (implementation assumption from the user's yes).

## Rule v2 (`rvol-v2`, user-confirmed 2026-09-27)

Evaluated on each closed one-minute bar, per symbol and session, over the last `window` = 3 contiguous bars plus the bar before them. An alert requires all of:

1. **Volume:** window volume ≥ `threshold` (3) × the median window volume ending at the same New York minute, same session, over the previous `days` (20) observed sessions; and ≥ `minVolume` (10,000) shares.
2. **Meaningful move:** move = close of the last window bar ÷ close of the bar before the window − 1. |move| ≥ `priceMultiple` (3) × the median |move| for the same symbol, minute and session over those sessions (so volatile symbols and volatile times of day, such as the open, need larger moves), and |move| ≥ `minMovePercent` (0.5%).
3. **One direction:** every window bar closes beyond the previous close (up: above; down: below) and every window candle has that color (up: close > open; down: close < open). Unchanged closes or doji candles break it.
4. **Fresh crossing and cooldown:** the previous evaluation did not meet all conditions, and ≥ `cooldown` (15) minutes since the symbol's last alert that day.

A low-volume or small-move crossing does not mark the state as crossed, so the alert fires once all conditions hold. Evaluations report `move`, `expectedMove`, `direction` and one of the statuses `insufficient-history`, `zero-baseline`, `below-threshold`, `low-volume`, `mixed-direction`, `small-move`, `suppressed`, `alert`. The first evaluable bar of a session is its fourth. v1 (5-minute volume only) is superseded.

Only contiguous closed bars within one session/date count. Warmup windows return no evaluation. Missing matching historical windows produce insufficient-history; zero medians produce zero-baseline. No older dates are substituted for missing windows. Entirely absent dates cannot be detected without a provider calendar and must be rejected/flagged by the future ingestion adapter. Replay is signal reconstruction, not a profitability backtest.

## Input contract

POST /api/replay with `{ "config": { "threshold": 3 }, "bars": [...] }`. Omit bars for a labeled synthetic demo. Config also accepts window, days, cooldown, minVolume, priceMultiple and minMovePercent. Response contains alerts with rule/config evidence and diagnostic counts. Upload size is bounded by Fastify's body limit (1 MiB); this is an in-memory prototype.

Each bar: `{ "ticker": "NVDA", "end": "2026-03-30T15:20:00.000Z", "date": "2026-03-30", "minute": 680, "session": "regular", "volume": 10000, "open": 101.2, "close": 101.5 }`.

end is the UTC close timestamp, date and minute are the New York session date and local end-minute. The adapter supplies calendar-verified pre/regular/post labels and only finalized bars. Early closes, holidays, adjustments and missing full sessions need provider normalization. Duplicate or out-of-order streaming bars are rejected. Replay sorts input by event time. Only earlier dates contribute to the baseline.

## Alpaca backtest

POST /api/backtest with `{ "tickers": ["AAPL"], "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "config": {...} }` fetches Alpaca SIP minute bars, including the 20 warmup sessions, and replays them through the live evaluator. The response lists the alerts the collector would have sent (each with its bar close price), diagnostic counts and per-symbol missing sessions. See the [task](../tasks/backend-alpaca-backtest.md).

## Current delivery

Deterministic streaming engine, JSON historical replay API, website demo/upload and ratio/liquidity controls. No live provider, database, price/sector charts or phone delivery yet. Historical input must contain its warmup history. The demo contains 21 synthetic weekdays with a single NVDA anomaly and accounts for March DST.
