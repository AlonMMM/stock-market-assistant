# Task: Day chart for each backtest alert

Status: implemented; real-data visual check pending
Owner: backend (web screen included at the user's request)
Branch: feat/alert-charts (based on feat/cloudflare-deploy)
Spec/contract revision: 4599979

## Outcome

On a Backtest alert, "Show day chart with SPY" opens the alert's US trading day
(pre-market through after-hours): the ticker and SPY as % change on one scale, ticker
one-minute volume below, the alert window highlighted and an alert marker. All times
are in Israel time (see [product](../product.md#display-conventions)).

## Contract

`POST /api/day-chart` `{ "ticker": "AAPL", "date": "2026-09-24" }` (US session date)
returns `series[]`: the ticker, then SPY (omitted when the ticker is SPY), each with
`previousClose` (last regular bar of the previous session, or null) and `bars[]` of
`{ start (Unix s, UTC), session, open, close, volume }`, plus
`beta: { value, returns, lookback }`. Same SIP source, 15-minute cutoff,
400/502/503 behavior and Worker/local parity as `/api/backtest`.

## Decisions

User-confirmed (2026-09-26): SPY is drawn as SPY % change × the ticker's beta. Beta is
the OLS slope of daily close-to-close returns (split-adjusted SIP daily bars) on SPY's
over the 60 trading sessions before the chart day; it needs at least 40 paired
returns, otherwise the chart shows SPY unscaled and says so. Volume bars are green for
an up minute and red for a down one (close vs open), strong inside the alert window.

Defaults, not user-confirmed:

- % change base: previous regular close; first trade of the day when unavailable.
- One % axis for both symbols (no dual price axis); volume in its own pane.
- Charts only for Backtest alerts; Replay data is synthetic.
- Library: TradingView Lightweight Charts 5.2.1 (lazy-loaded chunk, ~58 kB gzip).
- Bars are labeled by their close minute, matching alert timestamps.
- The chart opens on one hour either side of the alert; pinch/scroll shows the day.

## Verification evidence

- `tests/day-chart.test.ts`: series order, previous close, day filtering, SPY-only,
  15-minute cutoff, invalid input, local/Worker parity. `npm run check`: 36 tests pass.
- Rendered with SYNTHETIC bars at 390 px (inside an iframe; headless Chrome enforces
  500 px windows): no horizontal overflow; marker, readout and card agree on time.
- Not verified: real Alpaca bars, the hosted page, touch crosshair on a phone.

## Handoff

Pending: user check on the hosted site; optional session shading, sector comparison.

## 2026-09-27: overlay view

At the user's request (matching their trading platform), the chart opens in an
"Overlay" view: ticker price on the right axis and SPY price on the left, each
auto-fitted to the visible range, so the shape and timing of moves line up. This is
a deliberate dual-axis view; vertical distances do not compare move sizes, so the
readout shows both % changes. "% vs SPY×β" remains a toggle; the choice is remembered
per device. Alpaca's finest bars are one minute (the user's platform showed 10 s).
