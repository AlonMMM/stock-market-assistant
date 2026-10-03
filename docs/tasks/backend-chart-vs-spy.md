# Task: chart-vs-spy

Status: completed
Owner: backend
Branch: session/backend-chart-vs-spy
Spec/contract revision: 570b48c (docs/features/chart-vs-spy.md)

## Outcome

The web app can show a 0–100 "vs SPY score" on every day chart minute and in the
watchlist, computed with the same formula as the alert analysis score.

## Scope and exclusions

In: shared score function, `DayChart.vsSpy`, `BoardStats.rsScore`/`beta`, caching of
the board's β/σ, tests for scenarios 4, 5, 7. Out: all UI (Frontend session), price
labels and colours, removal of chart lines.

## Relevant context

- Spec: [chart-vs-spy](../features/chart-vs-spy.md) "Semantics", "Contract needs".
- Code: `packages/market-data/src/rs-score.ts` (new), `day-chart.ts`, `board.ts`,
  `volume-baseline.ts`, `packages/analysis/src/relative-strength.ts`,
  `apps/api/src/{app,server,worker}.ts`.

## Contract (additive; no existing field changed)

```ts
// packages/market-data/src/rs-score.ts
rsScore(excessPct, sigma): number | null // round(clamp(50 + 10·excess/σ, 0, 100))
excessPercent(stock, benchmark, beta)     // stock − β·benchmark
interface SpyStrength { beta: number; betaAssumed: boolean; betaReturns: number; sigma: number | null }
scoreSeries(stock, spy, { beta, sigma }): (number | null)[] // per stock bar

// POST /api/day-chart
DayChart.vsSpy?: SpyStrength & { spy?: ChartSeries }
// GET /api/board
BoardStats.rsScore?: number | null; BoardStats.beta?: number | null
```

- `vsSpy` is always against SPY. SPY's minute series is the `series` entry whose ticker
  is `"SPY"`; only when no entry is SPY (sector benchmark) is it carried in
  `vsSpy.spy` (same `ChartSeries` shape, no `typicalVolume`). Frontend:
  `spy = series.find(s => s.ticker === "SPY") ?? vsSpy.spy`, then
  `scoreSeries(series[0], spy, vsSpy)` (importable, pure) gives the score per bar;
  SPY's close is its latest bar starting at or before the stock bar. `sigma: null` →
  "—". `betaAssumed` → "β assumed" (β = 1 used).
- `vsSpy` is absent only when a sector chart's SPY minute bars could not be loaded.
- The existing `DayChart.beta` is unchanged: it is β vs the chart's benchmark
  (`series[1]`), i.e. vs the sector ETF on a sector chart; its comment now says so.
- Board: `rsScore` at `stats.asOf` from the previous daily close (the board's
  `previousClose`) to the newest complete 5-minute bar of the stock and of SPY.
  `beta` is null when β is assumed (the score still uses β = 1). Both are null when the
  β/σ history failed or a base/bar is missing.

## Acceptance criteria

Scenarios 4, 5, 7 of the spec (tests/rs-score.test.ts); the analysis score is
unchanged (tests/relative-strength.test.ts unchanged and passing); day chart and board
return 200 with nulls/absent fields when the extra history fails.

## Plan and decisions

- σ/β come from split-adjusted daily bars of the 61 sessions before the day, ending at
  that day's 00:00Z (no look-ahead). σ uses the last 20 returns; ≥ 15 needed.
- Day chart: daily bars are fetched once per symbol and shared between the existing β
  and `vsSpy` (SPY benchmark: no extra request). Sector benchmark: +1 SPY minute request
  (bar cache applies) and +1 SPY daily request. Extra SPY requests are caught: β assumed
  / σ null, or `vsSpy` absent; existing failure behaviour of the chart is unchanged.
- Board: one `multiHistory(listed + SPY, 1Day, split)` request on a board date's first
  poll; β/σ per ticker stored in a new `spy_strength` table in the bar-cache database
  (local SQLite and Worker D1), keyed by (board date, ticker); older dates dropped on
  write. Later polls: one D1 read, no Alpaca call. Failures and responses without SPY
  history are not stored. `D1BaselineStore` was generalised to `D1DailyStore<T>` (same
  `volume_baselines` SQL).
- Worker budget: cold poll +1 Alpaca request (+1 page above ~160 symbols, 61 bars each)
  and +2 D1 statements; warm poll +1 D1 query. CPU: one 60-return regression per symbol
  per day.
- Assumption: the board scores against the daily previous close (consistent with its %
  display) while the day chart uses the last regular minute close; they can differ by
  a few cents.

## Verification evidence

- `npm run check` (format, typecheck, tests, build): exit 0; 188 tests, 187 pass,
  0 fail, 1 skipped (pre-existing: technical scan needs `TECHNICAL_SCAN_PYTHON`).
- `git diff --check`: clean.
- Not verified against live Alpaca data; all fixtures are synthetic.

## Handoff

Integration: review the additive contract above and record it in shared docs/state.
Frontend: consume `vsSpy` / `scoreSeries` and `stats.rsScore`; treat absent fields as
"—". Open question: whether a score should be shown for SPY itself (currently β 1,
σ 0 → null, shown as "—").
