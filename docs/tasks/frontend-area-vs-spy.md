# Task: area-vs-spy

Owner: frontend
Status: implemented, awaiting the backend's day-chart/board data and Integration
Branch: session/frontend-area-vs-spy

## Outcome

The site shows the area score vs SPY ([spec](../features/area-vs-spy.md)) with no
direction labels: alert cells, the day chart (header, readout, new gap pane) and the
watchlist column.

## Acceptance criteria

- Live and Backtest alert cells show only the alert-time score, coloured green ≥ 60 /
  red ≤ 40 / grey between; "stronger / weaker / normal vs SPY" is in the tooltip and
  accessible label only; "—" when null or absent. Old alerts that still store a `label`
  show the score only (colour from the score, label ignored).
- Expanded line unchanged: "vs SPY at alert 72 → now 64 ↓ · β 2.0".
- Day chart header "vs SPY 72 / 100": at the alert minute in "Around alert" for alert
  charts, otherwise the latest bar. Readout "Score N" for the pointed minute.
- Gap pane under the price pane: gap(t) from `areaVsSpy.gap`, green fill above 0, red
  below, dotted zero line, faint weight ramp from the backend's session window
  (`areaVsSpy.windows`) to the header's end minute. The 5-minute opposite-to-SPY bands,
  strip and chips stay.
- Watchlist "vs SPY score" column: board `stats.rsScore`, same colours and words.
- Notes/legends (Live alerts, Backtest alerts, watchlist, day chart) explain: "area
  between the stock and β×SPY since the session open, recent minutes weigh more;
  50 = normal". All "confirmed / against / moving with market / Long / Short" text
  removed.

## Dependencies and scope

- Spec: `docs/features/area-vs-spy.md` at 0011269.
- Contract: `packages/contracts/src/vs-spy.ts` at c2ca70a (`session/backend-area-vs-spy`):
  `AlertVsSpy` (label deprecated/optional), `AreaVsSpySeries`, `vsSpyTone`,
  `vsSpyStrong`/`vsSpyWeak`. The web uses the shared tone and thresholds.
- Day chart: the web reads `DayChart.areaVsSpy` (the field named in the contract
  comment). At c2ca70a `day-chart.ts` does not yet declare or send it, so the web types
  the response locally as `DayChart & { areaVsSpy?: AreaVsSpySeries }`
  (`DayChartWithArea` in `chart-model.ts`); until the backend sends it the header and
  readout show "—" and the gap pane is not drawn. Once Backend adds the field to
  `DayChart`, the local intersection can be dropped.
- Board: unchanged field `stats.rsScore`; the backend switches its meaning to the area
  score.
- Not touched: the analysis follow-up's own relative-strength panel (`Analysis.tsx`,
  "Against the index" / "against the alert"); the spec keeps it unchanged. Telegram is
  Backend's.

## Changes

- `apps/web/src/vs-spy-model.ts`: score-only cell (`scoreCell`, `vsSpyCell`), tone words,
  `areaScoreNote`; labels removed.
- `apps/web/src/AlertFeed.tsx`: `VsSpyTag` takes only `vsSpy`; coloured score chip.
- `apps/web/src/LiveAlerts.tsx`, `BacktestAlerts.tsx`: new tag call, table notes.
- `apps/web/src/chart-model.ts`: `chartScores` reads `areaVsSpy` (no formula in the web;
  the old `scoreSeries` use is gone), `headerIndex`, `weightRamp`, `gapPoints`.
- `apps/web/src/DayChart.tsx`: header, readout chip, gap pane (BaselineSeries + ramp
  AreaSeries + zero price line), pane label, legend.
- `apps/web/src/WatchTable.tsx`: coloured score cell, header tooltip, detail line, note.
- `apps/web/src/styles.css`: label-tag styles replaced by `.vs-spy-score` / `.score-chip`
  tones.
- Tests: `tests/vs-spy-model.test.ts`, `tests/chart-model.test.ts` (tones and boundaries,
  "—", old labelled alerts render the score only and no label words, header index,
  weight ramp incl. a missing minute, series alignment).

## Verification and handoff

- `npm run check`: passed (233 tests: 232 pass, 1 skipped, 0 fail; build OK).
- `git diff --check`: clean.
- Headless Chrome (CDP) against a SYNTHETIC mock API (scratchpad, not committed) at
  1280 and 390 px:
  - Alert cells: 72 green, 35 red, 50 grey, 58 grey on an old alert stored with
    `label: "confirmed"`, "—" for null score and for an alert without `vsSpy`.
  - Expanded NVDA row: "vs SPY at alert 72 → now 64 ↓ · β 2.0"; chart header 72 at the
    alert minute in "Around alert" (scenario 7, same number as the tag); "Today" / "Since
    open" switch the header to the latest bar; readout "Score N" follows the pointer.
  - Gap pane: green/red fill, zero line, ramp restarting at the regular open window.
  - Watchlist column coloured 72/50/35/—; on a phone the table scrolls horizontally
    inside its card as before.
  - Scenario 8: page text and the built bundle contain no "confirmed", "against SPY",
    "moving with market", "Long ·" or "Short ·".
- Not verified: Backtest page in the browser (same `VsSpyTag` component; its large
  response was not mocked); real API data (backend day-chart/board data not on the
  branch yet); dark mode is not supported by this site.
- Next: merge Backend's day-chart `areaVsSpy` and board commits, re-run the check and
  screenshots against the real API, then hand to Integration.
