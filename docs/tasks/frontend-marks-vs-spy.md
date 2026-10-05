# Task: marks-vs-spy

Owner: frontend
Status: implemented; ready for Integration
Branch: session/frontend-marks-vs-spy

## Outcome

The site shows the marked-sections score vs SPY ([spec](../features/marks-vs-spy.md))
in place of the area score. The day chart's gap pane becomes a contributions pane, the
header ends at the correct end minute, and every note explains the new definition.

## Acceptance criteria

- Contributions pane under the price pane (replaces "Gap vs β×SPY"): one bar per marked
  minute, height c(i) from `marksVsSpy.contribution`, green above 0 / red below (by sign).
  Opacity follows the weight relative to the header's end minute E: newest 1.0, 60 min
  old about 0.23, outside the window or after E 0.07. The 60 minutes up to E are shaded,
  with a dotted zero line. For alert charts in "Around alert", a hatched "alert excluded"
  band covers the alert's own `config.window` minutes. The pane is redrawn when the range
  changes (E moves). Light bands and the strip stay.
- Header "vs SPY N / 100": in "Around alert", the score at E = `marksAlertEnd(alert.end,
window)` (the last minute before the alert window), read with `marksScoreAt`. It
  equals the alert tag and Telegram value (scenario 7). Otherwise E is the latest bar
  clamped to the regular session: after hours the last regular bar (the day's closing
  score), before 09:30 "—" (Product+UX decision, 2026-10-05).
- Readout "Score N" = `score` with E = the pointed minute. When nothing is pointed at,
  the readout shows the header's end minute, so header and readout match (Product+UX
  decision, 2026-10-05).
- Notes (Live alerts, Backtest alerts, watchlist header tooltip and note, day-chart
  legend, score tooltips) use: "marked minutes only, each sized by the stock's 5-min move
  minus β × SPY's; recent minutes weigh more; the alert's own minutes are excluded;
  50 = normal". Tags, colours, the "at alert → now" line and the watchlist column are
  unchanged.

## Dependencies and scope

- Spec: `docs/features/marks-vs-spy.md` at 9f29b46.
- Contract: `packages/contracts/src/vs-spy.ts` at 48082bb, day chart, board and the rest
  at e485181 (`session/backend-marks-vs-spy`, both merged): `MarksVsSpySeries` (minute-indexed from 09:30 via `start`), `marksWeight`,
  `marksAlertEnd`, `marksScoreAt`, `marksWeightMinutes`; `AlertVsSpy.sum`.
- The web reads `DayChart.marksVsSpy` (declared and served since e485181).
- The web has no formula of its own: contributions, scores and weights come from the
  backend series and the shared helpers.

## Changes

- `apps/web/src/chart-model.ts`: `chartScores` maps the minute series onto bars;
  `endMinute` (regular-session clamp), `barAtOrBefore`, `scoreAt`, `contributionBars`,
  `barOpacity`, `alertWindowBars`;
  removed `headerIndex` and `weightRamp`.
- `apps/web/src/DayChart.tsx`: contributions pane (shade and bar histograms, zero line,
  hatched excluded-band primitive), `drawMarks` on range change, header at E, readout
  defaulting to E's bar, legend.
- `apps/web/src/vs-spy-model.ts`: `scoreNote` (was `areaScoreNote`); the `VsSpy` type
  accepts `sum` and old `area`/`label` records.
- `LiveAlerts.tsx`, `BacktestAlerts.tsx`, `WatchTable.tsx`: note text.
- Tests: `tests/chart-model.test.ts` covers series alignment including the 09:30 offset,
  the end minute including a missing bar and the regular-session clamp, the readout's
  default bar, the header equal to the series value at E
  (scenario 7), weights for scenarios 2 and 5, opacity, and the excluded window.
  `tests/vs-spy-model.test.ts`: fixture uses `sum`.

## Verification and handoff

- `npm run check` after merging e485181: passed (243 tests: 242 pass, 1 skipped,
  0 fail; build OK). The count dropped because Backend replaced the area tests.
- `git diff --check`: clean.
- Headless Chrome (CDP) against a SYNTHETIC mock API (scratchpad, not committed), at 1280
  and 390 px. The mock's `marksVsSpy` comes from the backend's `dayMarks` + `marksSeries`
  on synthetic bars with a constant synthetic σ.
  - Alert tag 61, chart header 61 in "Around alert" (E = the 20:00 bar); the default
    readout shows that minute (20:01 close) with Score 61. "Today" switches the header to the latest bar (56). The hover readout follows the
    pointer (19, 61, 37).
  - Pane: green and red bars by sign, older bars faded, the 60-minute shade ending at E,
    and the hatched "alert excluded" band over 20:01–20:04. The layout holds at 390 px.
  - The table note, tooltips and legend show the new text.
- Not verified: the real API with live Alpaca data, the Backtest page in the browser,
  and the watchlist column with real data. The after-hours clamp is covered by Node tests
  only (the mock has no post-market bars).
- Known, pre-existing: at 1280 px in "Around alert", strip bars at the left edge can
  cover the strip's "▲▼ vs SPY" tag.
- Next: merge Backend's final commits (board rsScore clamp and task doc were still
  uncommitted at e485181) and re-run the check. Integration checks scenario 7 on real
  data.
