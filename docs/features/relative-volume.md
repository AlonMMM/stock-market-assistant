# Relative volume

Approved: US stocks, extended hours, minute-close evaluation, same-time volume anomaly as the first feature. Opening/closing minutes remain eligible when unusual for their own time of day (implementation assumption from the user's yes).

## Rule v4 (`rvol-v4`, user-confirmed 2026-10-03)

v3 below, with these changes. The alert means "look at this stock now": a big move is
likely, in either direction. Direction is not predicted.

1. **One direction candle** (`directionBars` 3 → 1): only the last window bar must close
   beyond the previous close with a candle of the move's colour. Volume and move rules are
   unchanged.
2. **⭐ In play tag** (`inPlayDayRvol`, default 2, 0 = off): an alert is tagged when the
   symbol's volume so far today (all sessions) is ≥ 2× its median at the same minute over
   the previous `days` sessions (needs ≥ 10). Evaluations report `dayRvol` and `inPlay`. The
   tag never blocks an alert.
3. **Optional, off by default:**
   - N1 `todayVolumeMultiple` (0 = off): window volume ratio ÷ max(1, `dayRvol`) must be ≥
     this; status `busy-day-volume`.
   - N2 `todayMoveMultiple` (0 = off): |move| must be ≥ this × today's typical |move| over the
     same window length (median over today's regular minutes ending before the window; needs
     15, else the check does not apply); status `normal-for-today`. Evaluations report
     `todayMove`.

Configure live through the collector's `RVOL_CONFIG` (JSON), and in the site's Backtest form.

Evidence (`research/alert-tuning`, SIP, 47 stocks, holdout 2026-04-01…09-25, run once with
variants frozen): big-move-within-30-minutes rate v3 32% (33.8 alerts/day), one candle 31%
(42.2/day), one candle in play 38% (19.2/day) against a 10–11% base; N2 halves alerts with the
same rate and sharper intraday timing; no variant predicts direction at 5/15/30/60 minutes or
the close. Live IEX data fires far fewer alerts than these SIP figures.

## Rule v3 (`rvol-v3`, user-confirmed 2026-09-27)

Evaluated on each closed one-minute bar, per symbol and session, over the last `window` = 3 contiguous bars plus the bar before them. An alert requires all of:

1. **Last minute moved (opt-in):** when `lastBarMinMovePercent` > 0, the last bar's close must move at least that much from the previous close, otherwise the window is not evaluated (`weak-last-bar`). Default 0 (off) since 2026-09-27: at 0.5% it cut alerts about 6× and they validated worse than chance (17% good vs 30% baseline; off: 32%).
2. **Volume**, either of (the alert records which in `volumeBasis`):
   - **vs history:** window volume ≥ `threshold` (3) × the median window volume ending at the same New York minute, same session, over the previous `days` (20) sessions;
   - **vs today's pace:** window volume ≥ `paceMultiple` (3) × today's average window volume. Regular session only, inside the pace zone that excludes the first `paceSkipOpen` (30) and last `paceSkipClose` (30) minutes, whose volume is naturally far above the day's average; the average uses today's pace-zone bars before the window and needs ≥ `paceMinMinutes` (15) of them. The early close (13:00) is respected. 0 turns this off. At the open and close only the historical time-of-day comparison applies.

   And ≥ `minVolume` (10,000) shares.

3. **Meaningful move:** move = close of the last window bar ÷ close of the bar before the window − 1. |move| ≥ `priceMultiple` (3) × the median |move| for the same symbol, minute and session over those sessions, and ≥ `minMovePercent` (0.5%).
4. **One direction:** the last `directionBars` (3, at most `window`) bars each close beyond the previous close and have a candle of that color. Unchanged closes or doji candles break it.
5. **Fresh crossing and cooldown:** the previous evaluation did not meet all conditions, and ≥ `cooldown` (15) minutes since the symbol's last alert that day.

Evaluations report `ratio`, `paceRatio`, `volumeBasis`, `move`, `expectedMove`, `direction` and one of `insufficient-history`, `weak-last-bar`, `zero-baseline`, `below-threshold`, `low-volume`, `mixed-direction`, `small-move`, `suppressed`, `alert`. The first evaluable bar of a session is its fourth. v1 and v2 are superseded.

Only contiguous closed bars within one session/date count. Warmup windows return no evaluation. Missing matching historical windows produce insufficient-history; zero medians produce zero-baseline. No older dates are substituted for missing windows. Entirely absent dates cannot be detected without a provider calendar and must be rejected/flagged by the future ingestion adapter. Replay is signal reconstruction, not a profitability backtest.

## Input contract

POST /api/replay with `{ "config": { "threshold": 3 }, "bars": [...] }`. Omit bars for a labeled synthetic demo. Config also accepts window, days, cooldown, minVolume, priceMultiple, minMovePercent, lastBarMinMovePercent, directionBars, paceMultiple, paceMinMinutes, paceSkipOpen and paceSkipClose. Response contains alerts with rule/config evidence and diagnostic counts. Upload size is bounded by Fastify's body limit (1 MiB); this is an in-memory prototype.

Each bar: `{ "ticker": "NVDA", "end": "2026-03-30T15:20:00.000Z", "date": "2026-03-30", "minute": 680, "session": "regular", "volume": 10000, "open": 101.2, "close": 101.5 }`.

end is the UTC close timestamp, date and minute are the New York session date and local end-minute. The adapter supplies calendar-verified pre/regular/post labels and only finalized bars. Early closes, holidays, adjustments and missing full sessions need provider normalization. Duplicate or out-of-order streaming bars are rejected. Replay sorts input by event time. Only earlier dates contribute to the baseline.

## Alpaca backtest

POST /api/backtest with `{ "tickers": ["AAPL"], "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "config": {...} }` fetches Alpaca SIP minute bars, including the 20 warmup sessions, and replays them through the live evaluator. The response lists the alerts the collector would have sent (each with its bar close price), diagnostic counts and per-symbol missing sessions. Limits: at most 50 sessions, and as many symbols as fit the Worker's memory for the range and warmup (`maxSymbolsPerRequest` in `packages/market-data/src/backtest-limits.ts`: 4 at 20 sessions, 1 at 40–50); larger requests get HTTP 400. Computed symbols are cached in D1 (`result-cache.ts`) for the same rule version, code, dates and settings; the response's `results` field counts cache hits and misses. See the [task](../tasks/backend-alpaca-backtest.md).

## Current delivery

Deterministic streaming engine, JSON historical replay API, website demo/upload and ratio/liquidity controls. No live provider, database, price/sector charts or phone delivery yet. Historical input must contain its warmup history. The demo contains 21 synthetic weekdays with a single NVDA anomaly and accounts for March DST.
