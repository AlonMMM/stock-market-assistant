# Task: marks-vs-spy

Owner: backend
Status: implemented, awaiting review
Branch: session/backend-marks-vs-spy (spec commit 9f29b46 on main 746312f)
Commits: 48082bb (contract + shared module), e485181 (replacement everywhere),
bda4d53 (after-hours closing score), plus this task file.

## Outcome

The area score of [area-vs-spy](../features/area-vs-spy.md) is replaced everywhere by the
marked-sections score of [marks-vs-spy](../features/marks-vs-spy.md): alerts (collector
and backtest), the live "now" score, the Telegram line (format unchanged), the board's
`stats.rsScore` and a new day-chart series. The alert analysis keeps its own day-based
score (unchanged).

## Acceptance criteria

Spec scenarios 1–6 are Node-tested (`tests/marks-vs-spy.test.ts`), plus the null rules,
σ with unmarked sessions counted as 0, and alert = chart value at the alert's E (scenario
7, backend side; also in `tests/alert-vs-spy.test.ts`). The after-hours closing score
(Product + UX, 2026-10-05) is tested for the board and `strengthNow`. Scenario 7 on the
site is Frontend's.

## Contract (as implemented)

`packages/contracts/src/vs-spy.ts`:

- Alert `vsSpy`: `{ score, sum, beta, betaAssumed, spyLagged }`. `sum` = I in % points
  (4 decimals); typed optional because older records lack it (read as null). Old
  records with `area` (typed optional, `@deprecated`) or `label` still parse; their
  `score` is the older score. `spyLagged` now means "SPY had no bar of its own at E".
- `StrengthNow` keeps its shape (`{ score, at }`): E = the symbol's latest bar; once
  that bar is after-hours, E = its last regular bar of that date (the day's closing
  score); null while it is pre-market. `at` = end of the bar at E.
- `marksWeightMinutes = 60`; `marksWeight(end, minute)` (Unix s of bar starts) →
  `(60 − age) / 60` for age 0…59, else 0.
- `marksAlertEnd(alert.end, alert.config.window)` → Unix s of E's bar start = alert bar
  end − (window + 1) minutes (alert bar ending 15:50, window 3 → E = the 15:46 bar).
- `MarksVsSpySeries` for `DayChart.marksVsSpy` (declared on the `DayChart` type in
  `day-chart.ts`): one entry per regular minute, index k = bar starting `start + 60·k`
  (k = 0 at 09:30 New York), through the ticker's last regular bar: `contribution`
  (c = tR − β·bR, null unmarked), `mark` (`strong` / `weak` / null, from `opposite()`),
  `sum`, `sigma`, `score` (each with E = k), `beta`, `betaAssumed`. Absent for SPY or
  without SPY's minute bars. The web draws weights from its chosen end minute with
  `marksWeight`; contributions do not depend on E.
- `marksScoreAt(series, end)` → `score[k]` or null outside the series. Header "latest
  bar" = `score.at(-1)` (also after-hours: the closing score); alert chart =
  `marksScoreAt(series, marksAlertEnd(alert.end, alert.config.window))`.
- Board `stats.rsScore`: E = the minute bar closing at `asOf`, clamped to the last
  regular minute after the close; null before 09:30.
- Deprecated, kept only so the web compiles until Frontend switches: `AreaVsSpySeries`,
  `DayChart.areaVsSpy` (never sent now), `AlertVsSpy.area`, the label helpers.

## Implementation

- `packages/market-data/src/marks-vs-spy.ts` (pure): `dayMarks` runs `opposite()` once
  per (symbol, date) and keeps per regular minute the mark and its β-free moves
  (`opposite()` now also returns `tickerMoves` / `benchMoves`, additive). I = T − β·B, so
  history is β-free; the alert and the chart sum in the same order, so they are equal.
  `sigmaCurve` (390 values, 4 significant digits), `marksAt`, `marksSeries`,
  `normalCdf` (moved from the area module), null rules.
- `alert-vs-spy.ts`: score at E = alert minute − `config.window`.
- `marks-sigma.ts` (replaces `area-sigma.ts`): `marksSigmas()` and `D1MarksSigmaStore`
  (table `marks_sigma`, 16 rows per INSERT, ~3 KB per curve).
- Collector (`live-strength.ts`, `store.ts`, `main.ts`): σ from the stored bars of the
  previous 20 sessions; SQLite `marks_sigma` (the old `area_sigma` table is dropped at
  start); the alert score waits ≤ 3 s for SPY's bar of E (normally already stored, since
  E is `window` minutes before the alert bar), then carries SPY's last close
  (`spyLagged`). Log event renamed `marks-sigma-incomplete`.
- Day chart: `marksVsSpy` built from the same `ChartSeries` objects the web passes to
  `opposite()`, so the pane's bars match the bands.
- Board: one 1-minute multi-symbol request per poll from 09:30 to min(`asOf`, regular
  close), none before 09:30 (before: from the session start, every session).
- Backtest: score at the alert's E from bars read so far; σ from memoized per-date marks
  of the previous 20 sessions. Code version sources: `area-vs-spy.ts` removed,
  `marks-vs-spy.ts` and `opposite.ts` added (cached backtests are invalidated).
- Removed: `area-vs-spy.ts`, `area-sigma.ts`, `tests/area-vs-spy.test.ts`.

## Decisions and deviations

- Alerts: an alert whose bar is outside the regular session scores null, even if E
  would fall inside it (e.g. a 16:00 alert, E 15:56). Latest scores (board,
  `strengthNow`, chart header) show the day's closing score after-hours (Product + UX
  decision 2026-10-05); the board clamps E to the last regular minute, `strengthNow` and
  the chart use the stock's last regular bar (they differ only for a stock without a
  bar at 15:59).
- Before marks can exist: no special rule; σ is 0 at minutes where no past session has
  a mark in its hour, which gives null. On the scored day, I = 0 with σ > 0 gives 50.
- σ sessions: a past session counts when the stock and SPY both have regular bars that
  day (and a base); a counted session without marks adds I = 0. Each session counts
  only at minutes it was open (early closes).
- Previous close: the previous session's last regular minute close (chart, collector,
  backtest) or the daily bar's close (board, no extra request). For the first of the 20
  history sessions, whose previous session is outside the fetched range (collector,
  board, chart), the session's first regular open is the base: it only rescales that
  day's moves by its opening gap. The backtest usually has that previous session
  (warmup) and uses it, a negligible difference from live.
- Not scorable (sum and score null): SPY itself, E outside the regular session, no SPY
  regular bar or base by E, no stock regular bar by E. Missing σ or σ = 0: sum reported,
  score null.
- σ uses the scored date's β for all 20 sessions (as before); curves are stored only
  with the date's β.
- `tests/subrequest-budget.test.ts`: the fake Alpaca now gives each stock a phase offset
  from SPY (same worst-case density); with identical phases no minute is ever marked and
  σ would always be null.
- The collector's bars come from its stream feed (IEX unless `ALPACA_FEED=sip`); the
  API uses SIP. Telegram and site values can differ slightly with IEX.

## Costs

- Collector: no extra Alpaca requests. σ per symbol: 20 × `opposite()` over ~960 bars
  plus 60 × 390 weighted sums (a few ms; not measured on real data), once per day. Per
  alert / `/alerts` poll: reads the stored bars of the session and the previous one for
  the symbol and SPY; compute < 1 ms. Storage ~3 KB per symbol per day (was ~7 KB).
- Day chart (measured, synthetic worst-case density, cold cache, every statement
  counted): 23 subrequests cold, 7 warm (unchanged).
- Board (budget 40, `tests/subrequest-budget.test.ts`, 30 symbols, cold): 37 (Rel vol
  and β), 35, 35, 23; all 30 scores filled by the 4th poll; k = 12 σ curves per poll.
  The σ write is 1 + ⌈k/16⌉ statements (was ⌈k/8⌉). No 1-minute request before 09:30.
- Backtest: no extra requests; per symbol one `opposite()` per past date (memoized) and
  per alert; small next to the replay. Memory was not re-measured.

## Verification

- `npm run check` (on bda4d53): pass (format, both typechecks, 240 tests: 239 pass,
  0 fail, 1 skipped; builds).
- `npm run build:collector`: pass (`dist/collector.mjs` 118.2 KB).
- `git diff --check` over the branch's commits: clean.
- Synthetic data only; no real Alpaca, collector, D1 or Worker run. The AVGO
  2026-09-03 prototype case (≈ 73 raw) was not reproduced: no cached SIP data in this
  worktree.

## Open questions

- The Worker's D1 still has the old `area_sigma` table (no longer read or written);
  Integration may drop it (`DROP TABLE area_sigma`). The collector drops its own copy.
- Alerts outside the regular session (pre-market, after-hours) always show "vs SPY —".
- Colour thresholds 60/40 and the 60-minute window are unvalidated; the backtest carries
  the new score for that study.

## Handoff

Frontend: build on the contract above (`marksVsSpy` pane, `marksScoreAt` /
`marksAlertEnd` for the header at the alert's E, `marksWeight` for opacity), then delete
`AreaVsSpySeries`, `DayChart.areaVsSpy` and the label helpers. Integration: review costs,
the D1 table rename and the alert-outside-session rule; no deployment or settings were
changed.
