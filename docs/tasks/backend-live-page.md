# Task: live-page (Backend)

Status: completed
Owner: backend
Branch: session/backend-live-page
Spec/contract revision: 6c82de2 (docs/features/live-page.md)

## Outcome

The Frontend can build the Live page redesign against real data:

- `opposite()` marks opposite-to-benchmark minutes and episodes for the day chart.
- `POST /api/day-chart` returns `typicalVolume` for the requested ticker.
- `GET /api/board` returns `stats` (day range, volume, typical volume, Rel vol) for
  watchlist symbols.

## Scope and exclusions

In scope: the three items above, with Node tests and local/Worker parity. Excluded:
all Frontend work, β-adjusted alert context, any watchlist ranking of opposite minutes,
`docs/state.md` (Integration).

## Contract as implemented

All additions are optional/additive; no existing field, request or error changed.

- `packages/market-data/src/opposite.ts` (browser-safe, imports only the calendar):
  `opposite(ticker, bench, options?) → { states: ("strong"|"weak"|null)[], episodes: { kind, from, to }[] }`.
  `oppositeDefaults = { window: 5, benchFall: -0.05, benchHold: -0.02, weakMultiple: 2, minUsualMoves: 15 }`
  (% points; thresholds are signed).
- `ChartSeries.typicalVolume?: (number | null)[]` — aligned with `bars`, requested
  ticker only (absent on the benchmark series; when `ticker === benchmark` the single
  series has it).
- `BoardSeries.stats?: BoardStats` — watchlist symbols only (SPY/QQQ/sector ETFs that
  are not in the watchlist have none):
  `{ asOf, dayLow, dayHigh, volume, typicalVolume, relVolume }` as in the spec.

## Decisions made in this session

1. **Opposite: timestamp alignment with carry-forward.** Values are looked up by bar
   start time. A minute without a bar had no trade, so the latest earlier regular-session
   close is used (never a pre-market close). An episode's `from` is the ticker bar index
   that supplied the i−5 value.
2. **Opposite: `usual` includes minute i itself** ("up to i"); 15 moves means 15
   evaluated regular minutes (i ≥ open + 5) with both ticker ends available.
3. **Opposite: weak needs `usual > 0`.** With a zero median, `tR ≤ −2 × 0` would mark
   flat minutes as falls. Strong needs `tR ≥ 0` exactly as specified.
4. **Opposite: float tolerance 1e-9** on thresholds so a −0.05 benchmark move computed
   from prices counts as −0.05 (scenario 12 boundary).
5. **Episodes** merge adjacent ticker bar indices of the same kind.
6. **Day-chart typical volume** counts only prior sessions that have a bar at that
   minute/session (as in the relative-volume evaluator); median of those, null below 15.
   Dates whose 20 prior sessions fall outside calendar coverage get all nulls (the
   request still succeeds).
7. **Board `asOf`** is the latest 5-minute boundary at or before the data cutoff
   (now − 15 min, capped at 20:00 New York), the same for every symbol, rather than each
   symbol's own newest bar: a thin symbol's last trade would otherwise compare its volume
   with an earlier, smaller typical value. `volume` sums regular 5-minute bars that end
   by `asOf` (the possibly incomplete newest bar is excluded).
8. **Board day range** uses all of today's bars, including the newest (possibly
   incomplete) one, so the last price in `points` is never outside the range.
   After-hours bars are included as well.
9. **Board typical volume**: a prior session counts at minute m when it has any regular
   bar and its regular session was open at m (early closes stop at 13:00). After the
   close, today's cumulative volume and the typical value both cover the full regular
   session. `relVolume` is null when `typicalVolume` is null or 0.
10. **History failures degrade:** if the Rel vol history request fails, the board still
    returns 200 with `typicalVolume`/`relVolume` null (not stored, retried next poll).
    Failures of today's requests keep the existing 502.

## Data path and cost (board)

- Today's stats reuse the existing 5-minute intraday request: **no extra request**.
- History: per board date, **one request per previous session** (20, in parallel) for
  the watchlist symbols missing from the store, covering only 09:30–close New York as
  5-minute bars: ≈ 78 bars × symbols per request (30 symbols ≈ 2,340 bars, one page;
  ~47k bars total). One continuous 20-day range would include extended hours (~2.5× the
  bars) and page sequentially (~12 pages for 30 liquid symbols).
- The result is reduced to a 78-number curve per symbol and stored in a new
  `volume_baselines` table in the bar-cache database (local SQLite, Worker D1
  `BARS_CACHE`), keyed by (board date, ticker). Later polls that day cost **one D1
  query** and no Alpaca request. Older dates are deleted on write.
- Worker subrequests on a cold poll: watchlist 1 + intraday 1+ + daily 1 + history 20 +
  D1 ~3 ≈ 26 (Free limit 50). Watchlists above ~128 symbols need two pages per history
  request (up to 40 requests), near the limit; see remaining work.
- Not reused: the minute-bar rows (`minute_bars`). Reading 20 days × N symbols of
  1-minute bars on every poll would cost N D1 queries and far more CPU than one stored
  curve per symbol; "reuse the bar cache" is honoured at the storage level.

## Data path and cost (day chart)

The requested ticker's existing 1-minute history request now starts 20 sessions back
(the benchmark's is unchanged), through `minuteHistory` and the bar cache: finished days
are served from the cache after the first view; uncached it adds ~20 days of minute bars
(~2–3 extra pages). The 15-minute SIP cutoff and all errors are unchanged.

## Verification evidence

Tests (synthetic data, labelled in the files):

- `tests/opposite.test.ts`: defaults object; scenario 12 strong (−0.06 and −0.05
  strong, −0.04 none), falling ticker not strong, weak 2.1× vs 1.9×, no weak before 15
  moves; scenario 13 (pre-market and first five regular minutes have no state);
  timestamp alignment with missing benchmark minutes; missing previous close.
- `tests/day-chart.test.ts`: typical volume per minute/session over 20 sessions,
  scenario 9 (10 and 14 sessions → null, 15 → value), no look-ahead from later dates,
  benchmark series has no `typicalVolume`; request-range assertion updated.
- `tests/board-stats.test.ts`: normal case, scenario 8 (null before the open; first bar
  after the open), scenario 9 (10 vs 15 sessions), after the close, stored baselines
  skip history requests, history failure degrades, early-close sessions, D1 store round
  trip (node:sqlite), local/Worker parity for `/api/board`. `tests/board.test.ts`
  updated for the added history calls.

Commands run in the worktree after the last code commit:

- `npm run typecheck` — passes.
- `npm test` — 104 tests, 104 pass, 0 fail.
- `npm run build` — passes.
- `npm run check` — **fails at `format:check`** on 6 files from spec commit 6c82de2
  (`docs/features/live-page.md`, `docs/features/live-page-mockup/*`), not touched here.
  All files changed in this task pass Prettier.
- `git diff --check` — clean.

No real Alpaca calls were made; no deploy, push or PR.

## Handoff

- Merge before the Frontend branch. The Frontend imports `opposite` from
  `packages/market-data/src/opposite.js` and reads `stats` / `typicalVolume` when present.
- Integration: format or prettier-ignore the spec/mockup files from 6c82de2 so
  `npm run check` passes; update `docs/state.md`. The Worker needs no new binding (it
  reuses `BARS_CACHE`; the table is created on first use).

Remaining work and open questions:

- Validate on real SIP data: Alpaca's handling of the incomplete newest 5-minute bar,
  the opposite-rule thresholds, Rel vol values against another source.
- Large watchlists (> ~128 symbols) may approach the Worker subrequest limit on the first
  poll of a day; spread the history fetch across polls if that happens.
- Day range includes after-hours; confirm with Product+UX whether it should stop at the
  regular close.
