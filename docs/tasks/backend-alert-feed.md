# Task: Backtest across 30–40 symbols with a compact alert feed

Status: implemented; real-data check pending
Owner: backend (web screen included at the user's request)
Branch: feat/alert-feed (based on feat/alert-charts)

## Outcome

The user picks up to 40 symbols from the saved watchlist and sees every alert in one
compact feed: symbol, Israel time, ratio and the move against SPY × beta, newest first
or by ratio, filterable by symbol. Tapping a row opens the day chart in place.

## User-confirmed (2026-09-27)

Compact feed layout; watchlist selection preloaded from `config/alpaca-watchlist.json`
and remembered per device.

## Contract change

`BacktestAlert.context`: `{ change, spyChange, beta, excess }` or null. At the alert
minute, `change` and `spyChange` are % moves from each symbol's previous regular close
(SPY uses its latest minute closed within 5 minutes before the alert), `beta` follows
the day-chart definition (60 daily returns before the alert day) and
`excess = change − beta × spyChange`, the gap between the two chart lines. Null for SPY
itself or when any input is missing. Backward compatible for existing fields.

## Limits

The server still accepts 10 symbols per request; the page sends batches of 6
sequentially to stay within Cloudflare's per-request subrequest (about 50 on the free
plan) and CPU limits, reports progress, and lists failed batches without discarding
others. If real runs hit CPU limits, the Workers Paid plan or smaller batches are the
remedies.

## Verification evidence

- `tests/backtest.test.ts`: context values against fixtures with beta 1.5, request
  list including SPY, daily requests ending before the range end day.
- `npm run check` passes.
- Rendered with SYNTHETIC data at 390 px: watchlist chips, feed rows, filters and an
  expanded chart. The synthetic generator is path-dependent on the request start, so
  preview numbers differ between the row and the chart; real bars do not have this.
- Not verified: real 40-symbol run time and Cloudflare CPU limits.

## 2026-09-27 follow-up

- Replay mode was removed from the site at the user's request; Backtest is the only
  mode. `/api/replay` and the synthetic demo remain for tests.
- Real 47-symbol runs failed on later batches and on day charts with Cloudflare HTML
  error pages. Local profiling of one batch (6 symbols × 40 sessions of synthetic
  minute bars) measured about 630 ms CPU per symbol; the free Workers plan allows 10 ms
  per request. The history-coverage check (string keys per bar) and New York time
  conversion (Intl per bar) were optimized to about 240 ms per symbol without behavior
  change (all tests; `newYork` matched Intl at every sampled minute 2026–2028). This
  remains far above the free-plan limit; hosting choice pending with the user.
- Non-JSON responses now show "Server limit reached (HTTP …)" instead of a parse error.
