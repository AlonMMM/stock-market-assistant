# Task: chart-vs-spy

Owner: frontend
Status: ready for integration
Branch: session/frontend-chart-vs-spy
Spec: [chart-vs-spy](../features/chart-vs-spy.md) at 570b48c. Contract: Backend
`session/backend-chart-vs-spy` up to ad25ebd (merged here), `rs-score.ts` `scoreSeries`,
`DayChart.vsSpy`, `BoardStats.rsScore`/`beta`.

## Outcome

The shared day chart (Live alert rows, watchlist rows, Backtest alert rows, market chart):

1. No entry/good/stop lines and no entry or good/stop point markers (Product+UX
   decision 2026-10-03); the alert marker and the Backtest trade-view outcome text stay,
   and the Backtest note no longer says the chart marks them. `outcomeLevels` and its
   test, and DayChart's `outcome`/`direction`/`units` props, were removed.
2. Readout: `NVDA +2.31% · $131.62`, `SPY +0.31% · $573.10` (or the sector ETF) for the
   pointed or latest minute. Axis last-value (and crosshair) labels show the same pair
   when the chart is ≥ 600 px wide; narrower charts keep % only (two price labels would
   squeeze the plot on phones). Tick marks stay % only.
3. Green = held while SPY fell (stronger), red = fell while SPY held (weaker): light band
   fills, darker strip (#166534 / #991b1b) tagged "▲▼ vs SPY" on the canvas, summary
   chips with ▲/▼, readout chip, legend ("Green (▲ stronger)… Red (▼ weaker)…").
   Volume bars unchanged.
4. Score vs SPY: header "vs SPY score 72 / 100" (last bar; "· β assumed" when flagged),
   readout "Score 65 / 100" for the pointed minute, legend explains "50 = moving like SPY
   × β". "—" when `vsSpy` or SPY's minutes are absent or σ is null; hidden on SPY's own
   chart. Watchlist: sortable "vs SPY score" column after "vs SPY | vs sector" (default
   sort unchanged, "—" last both ways, always against SPY), plus score and β in the
   expanded row; table note explains the score.

Pure logic in `chart-model.ts` (`signed`, `signedPercent`, `dollars`, `percentAndPrice`,
`percentBase`, `priceAt`, `chartScores`, `scoreText`) and `live-model.ts` (`rsScore`
on `WatchRow`, sort key). The score itself is Backend's `scoreSeries`, not reimplemented.

Also fixed: the watch table's screen-reader text (absolutely positioned) widened the page
to ~755 px on phones; `.watch-table` is now `position: relative`.

## Verification

- `npm run check` passed (Prettier, types, 191 tests: 190 pass, 1 skipped, build);
  `git diff --check` clean.
- New Node tests: price/percent labels (scenario 2), per-minute score incl. sector chart
  via `vsSpy.spy`, clamp and no-σ cases (scenarios 4, 5), no score without `vsSpy`/SPY or
  for SPY itself; watchlist score column, sort with "—" last in both directions and with
  "vs sector" (scenario 6).
- Headless Chrome against a SYNTHETIC mock API (scratchpad, not committed; made-up bars
  designed to produce one green and several red episodes) at 1280 and 390: watchlist
  table + score column (sort ▼/▲, vs sector keeps SPY scores), NVDA watchlist row chart
  (vs SPY and vs SMH), Live TSLA alert chart (β assumed), Backtest alert chart (no
  horizontal lines, trade view text present; re-checked at 1280 after the
  markers were removed: only the alert marker remains). Hover with real CDP mouse events at 1280
  updates time, both %·$ pairs and the score; leaving returns to latest. No page overflow
  at 390 (after the fix above); no console errors. A run without `vsSpy` shows "—" in
  header and readout and "not available" in the legend. Screenshots inspected, not
  committed.
- Not verified: the real API path (no `.env`/live data in this worktree); screen readers;
  touch interaction on a real phone.

## Open questions / handoff

- On phones the expanded watchlist row sits inside the horizontally scrolling table (as
  before), so its chart is wider than the screen; the extra column makes the table 1044
  px min instead of 940.
- `docs/features/live-page.md` still describes red/blue bands; the chart-vs-spy spec
  amends it. Integration may want to update that text.
- Header score and the board score can differ slightly (board uses the previous daily
  close, chart the last regular minute close); accepted by Product.
