# Look-now score (alert validation)

User-confirmed 2026-10-03. The backtest's main grade for an alert: after it, did the stock
move much more than is normal for itself, quickly, apart from the market? It replaces the
✅/❌/⏸ stop/target result, which stays available as the "trade view" for testing an entry
rule. Code: `packages/market-data/src/look-now.ts`.

## Definition

- **Entry:** the open of the first regular bar within 3 minutes after the alert minute.
- **Horizons:** 5, 15, 30, 60 minutes, and the regular close.
- **Move at horizon h:** the largest market-adjusted move from the entry within h, with
  its sign: on log prices, `ln(stock) − β·ln(SPY)` relative to the entry, reported as a
  percentage. β is the 60-session daily beta; 1 when unknown (flagged), 0 for SPY itself.
- **Normal move σ_h:** the median |move| from the same alert minute over the stock's
  previous 20 sessions (needs 10).
- **z_h = |move_h| ÷ σ_h**, and its **percentile** among random minutes: every 5th regular
  minute of the same run (same stocks and days), scored the same way.
- **Score (0–100):** the weighted average of the percentiles, with weights 5m 35%, 15m 25%,
  30m 20%, 60m 12%, close 8%, re-normalized over the available horizons.
- **Label:** Very big ≥ 97, Big ≥ 90, otherwise Normal. Also shown: the peak horizon (the
  highest percentile) and whether that move went with or against the burst.

## Edge cases

- **Horizons ending after the regular close are dropped** and the weights re-normalized.
  Under 5 minutes before the close only "close" remains; alerts within 60 minutes of the
  close are flagged "near the close". The early 13:00 closes come from the calendar.
- **Unscored:** outside regular hours; the last regular minute ("No time left in the
  session"); no bar within 3 minutes after the alert; no σ history for any horizon.
- **Missing minutes:** the peak uses the bars that exist; a horizon without bars is dropped.
- **SPY without a price** for the session (or the SPY ticker): the move is raw, flagged `*`.
  SPY minutes before its first bar use the entry level.
- **Backtest batches** (3 symbols per request) rank against their own random minutes. The
  page combines the batches' baselines by weighted average.

## Evidence (2026-10-03, SIP, 47 stocks, 2025-10-01…2026-09-25)

`scripts/research/look-now-check.ts` on branch `research/alert-tuning`: random minutes average
50 (Big 3.9%, Very big 0.8%); v4 alerts average 70 (Big 20.7%, 5.3×; Very big 6.5%, 8.6×); ⭐
in-play alerts 76 (Big 28.3%, 7.2×). The peak went with the burst 49.7% of the time. The extra
work per backtest batch is about 90 ms of CPU on top of about 265 ms for the replay and the old
validator (measured locally).
