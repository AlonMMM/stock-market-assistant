# Task: area-vs-spy

Owner: backend
Status: implemented, awaiting review
Branch: session/backend-area-vs-spy (spec commit 0011269 on main f1d471a)

## Outcome

The day-based vs-SPY score and its direction labels are replaced by the area score of
[area-vs-spy](../features/area-vs-spy.md) on alerts (collector and backtest), the live
"now" score, the Telegram line, the board's `stats.rsScore` and a new day-chart series.
The alert analysis keeps its own day-based score (spec: unchanged).

## Acceptance criteria

Spec scenarios 1–6 are Node-tested (`tests/area-vs-spy.test.ts`), plus carry-forward of
missing minutes, no future data, the null rules, the Telegram line without labels
(scenario 8 for Telegram), and alert = chart value for the same minute (scenario 7,
backend side). Scenarios 7–8 on the site are Frontend's.

## Contract (as implemented)

- `packages/contracts/src/vs-spy.ts`
  - Alert `vsSpy`: `{ score, area, beta, betaAssumed, spyLagged }`. `area` is % points
    (4 decimals). Old records may carry `label` (typed optional, `@deprecated`) and lack
    `area` (read as null); their `score` is the old day-based score.
  - `StrengthNow` unchanged (`{ score, at }`); score = area score ending at the symbol's
    latest bar.
  - `vsSpyTone(score)` → `stronger` (≥ 60) / `weaker` (≤ 40) / `normal` / `none`;
    `vsSpyLine(vsSpy)` → `vs SPY 72/100` or `vs SPY —`.
  - `AreaVsSpySeries` for `DayChart.areaVsSpy`: `gap`, `area`, `score`, `sigma` arrays
    aligned with `series[0].bars` (each value ends at that bar's minute), `windows:
{ session, start (Unix s of t0) }[]` for the weight ramp, `beta`, `betaAssumed`. Absent
    for SPY itself or without SPY's minute bars. Header "ending at the latest bar" =
    `score.at(-1)`; an alert chart's value = `score` at the alert bar's index.
  - Deprecated, kept only because the web still uses them: `VsSpyLabel`, `vsSpyLabel`,
    `vsSpyText`, `DayChart.vsSpy`, `rs-score.ts` `scoreSeries`. Remove once the web reads
    `areaVsSpy` / `vsSpyTone`.
- Board `stats.rsScore`: area score ending at the minute bar that closes at `asOf`.
- Compatibility edit outside Backend scope: `apps/web/src/vs-spy-model.ts` falls back to
  `vsSpyLabel(direction, score)` when an alert has no `label`, only so the web compiles
  until Frontend replaces the cell.

## Implementation

- `packages/market-data/src/area-vs-spy.ts`: pure math. Gap is linear in β, so each
  window keeps β-free running means `S`, `M` and `A = S − β·M`. Φ via Abramowitz &
  Stegun 7.1.26. σ curves `{ pre, regular, post }` indexed by New York minute − 240 /
  570 / 960, 4 significant digits (~7 KB JSON).
- `area-sigma.ts`: `areaSigmas()` (stored curves, else minute history one symbol at a
  time + SPY) and `D1AreaSigmaStore` (`area_sigma`, 8 rows per INSERT).
- Collector (`live-strength.ts`, `main.ts`, `store.ts`): σ curves from the stored minute
  bars of the previous 20 sessions, computed after the warmup and on the 5-minute
  prepare loop, stored in SQLite `area_sigma` (pruned with bars at 120 days). Alert
  score reads the session's stored bars of the stock and SPY after the same ≤ 3 s SPY
  wait; a missing SPY bar at the alert minute carries SPY's last close (`spyLagged`).
- Backtest: area score at the alert bar from bars read so far; σ from memoized β-free
  windows of the 20 previous sessions; `area-vs-spy.ts` added to the code version.
- Day chart: `areaVsSpy`; σ from the ticker's already-loaded 20-session history and SPY's
  previous 20 sessions (bar cache), stored per (date, ticker).
- Board: one extra 1-minute multi-symbol request per poll from the session start to
  `asOf`. σ curves are bounded by a 40-subrequest budget per request (Workers Free
  allows 50): none on a poll that fetches Rel vol or β history, otherwise
  `sigmaSymbolsPerPoll(symbols, listed)` (k = 12 for 30 symbols), in a rotating order
  (start = poll minute) so a failing symbol never blocks the rest. Their 20-session
  history comes straight from Alpaca (≤ 2 pages a symbol, no D1 statements).
- Day chart: SPY's 20-session σ history also comes straight from Alpaca (≤ 2 pages).
- Worker and local API pass the σ store to board and day chart (the bar cache to the
  day chart only).
- `apps/api/src/sqlite-d1.ts`: batches now run one at a time. Concurrent batches (Rel
  vol and β/σ stores written in the same poll) nested `BEGIN` and failed locally, so a
  store write was silently lost; D1 itself was unaffected.

## Decisions and deviations

- "First 5 minutes" null: score is null while the window has ≤ 5 minutes (from the 6th
  minute on it is scored); `area` is still reported.
- Window t0: regular 09:30, after-hours at the regular close, pre-market at the stock's
  first pre-market bar; SPY's base is its first bar at or after t0. Minutes before either
  series' first bar in the window add nothing (neither weight nor value). A window runs
  to the latest minute of either series (capped at T).
- σ uses the scored date's β for all 20 past sessions. A σ curve is computed/stored only
  when the date's β request succeeded (an estimated-unknown β is 1, flagged); if the
  daily request fails, the score is null until a later prepare/poll.
- The `area_sigma` D1 table is shared by board and day chart and, like the other daily
  stores, drops dates older than the one written: a chart of a past date recomputes its
  σ (from the bar cache) after a newer date is stored.
- The collector's bars come from its stream feed (IEX unless `ALPACA_FEED=sip`); the API
  uses SIP. With IEX, Telegram and site values can differ slightly.

## Costs

- Collector: no extra Alpaca requests. σ: ~2.4 ms compute per symbol plus reading 20
  sessions of stored bars for the symbol (SPY once), estimated 1–2 s for 30 symbols once
  per day (startup after warmup, after New York midnight; not measured on real data).
  Per alert and `/alerts` poll: reads the session's stored bars of the symbol and SPY;
  compute < 0.1 ms. Storage ~7 KB per symbol per day.
- Day chart: warm +1 D1 query; the first chart of a (date, ticker) adds SPY's 20-session
  minute history (≤ 2 Alpaca pages) and one σ write. Measured (synthetic worst-case
  density, cold cache, all statements counted): 23 subrequests cold, 7 warm.
- Board (budget 40 per request, every Alpaca page and D1 statement counted, plus the
  watchlist request): every poll +1 Alpaca 1-minute request (pages = symbols × minutes
  since the session start / 10,000) + 1 D1 read. A poll that fetches Rel vol or β
  history computes no σ; later polls compute k σ curves (2 Alpaca pages each, SPY 2,
  one write of 1 + ⌈k/8⌉ statements). `tests/subrequest-budget.test.ts`, 30 symbols,
  cold cache, measured per poll: 37 (Rel vol and β), 36, 36, 23 — all 30 scores filled
  by the 4th poll. Watchlists far above 30 symbols get a smaller k; the existing cold
  Rel vol poll grows past the budget above ~128 symbols (unchanged, see
  backend-live-page).
- Backtest: no extra requests; per symbol ~0.1 ms per day of windows plus ~2.4 ms per
  alert date, small next to the replay (~630 ms per symbol). Memo of past windows ≈ 30 KB
  per day per symbol while that symbol is computed; backtest memory limits were not
  re-measured. Cached results are invalidated by the code-version bump.

## Verification

- `npm run check`: pass (format, both typechecks, 234 tests: 233 pass, 0 fail, 1
  skipped; builds).
- `npm run build:collector`: pass.
- `git diff --check`: clean.
- Synthetic data only; no real Alpaca, collector, D1 or Worker run.

## Open questions

- Alerts in a window's first 5 minutes (e.g. at the 09:30 open) always show "vs SPY —".
- The analysis follow-up keeps the day-based score, so its number no longer equals the
  alert's (alert-vs-spy scenario 7 no longer holds by design).
- Colour thresholds 60/40 are unvalidated; the backtest now carries the area score for
  that study.

## Handoff

Frontend: build on the contract above (tags via `vsSpyTone`, `areaVsSpy` for the gap
pane, readout and header), then delete the deprecated label helpers, `DayChart.vsSpy`
and `scoreSeries` (and the compatibility edit in `vs-spy-model.ts`). Integration: review
costs and the shared `area_sigma` table; no deployment or settings were changed.
