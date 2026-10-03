# Task: backtest-page

Owner: frontend
Status: ready for review
Branch: session/frontend-backtest-page

## Outcome

The Backtest view redesigned per the [spec](../features/backtest-page.md) (spec commit
fd18ce5), in the Live page's style, with `validation.baselineBySymbol` from the backend
branch (merged: 94b5cfe contract, ba7e59a implementation) and origin/main 7893467 (look-now
score, merged in 488c092).

## What was built

- Header with the shared status pill (polls `/api/live`); batch failures go to its
  warnings and to Data quality; the stacked `Notices` and the old `ValidationCard` /
  `AlertFeed` list were removed (`AlertEvidence` and `FeedAlert` stay for Live).
- Two columns (setup ≈ 360 px, results) that stack below 980 px; there the setup
  collapses into "Setup · N symbols · K sessions · rvol-v4 + N changes", expanded before
  the first run and collapsed when a run starts (reopened on a settings error).
- Symbols card: Whole watchlist, Alerted recently (current `/api/live` alerts; disabled
  "No recent live alerts" / while loading), one preset per sector benchmark ETF; preview,
  Add a symbol with inline errors, Edit list (chip picker). Selection saved per device.
- Dates card: Last 5/10/20 sessions from the exchange calendar ending on the last complete
  session (after 20:00 New York), Custom (focuses From); From/To always visible; session
  count and Israel-style range label.
- Rule card: generated live-rule sentence, badge, Customize rule with four groups, changed
  fields highlighted with "· live X", Reset. Scoring card with explanation.
- Run button "Run backtest · N symbols · K sessions", progress bar, batch note, errors
  beside the button (client validation and server settings errors stop the run);
  editing after a run keeps results with "Settings changed — run again".
- Results title, Download JSON, verdict (paired bars, pts vs random with better/worse in
  words and colour, forward medians, best run, unscored reasons, under-50 note), tabs:
  Alerts (outcome filter, symbol select, sort incl. Best run, outcome and best-run
  columns, In play tag, day chart Around alert with entry/good/stop price lines), By
  symbol (sortable, stacked bar with text label, faded < 5 scored sorted last, row opens
  Alerts filtered; "—" without a per-symbol baseline), Data quality (log-scale
  diagnostics, coverage, cache, failed batches with Retry these → reruns only those
  batches with the original run's settings and merges).
- Look-now score (from main): its card sits above the verdict, alert rows show the score
  badge and detail line, and the batch merge combines look-now summaries (baselines by
  weighted average). Conflict in `packages/market-data/src/backtest.ts` resolved as the
  union of both sides (`baselineBySymbol` and `lookNow`), no logic change.
- Wording per Product+UX: "baseline" / "ordinary momentum entries" instead of "random"
  (verdict, bars, differences, By-symbol "vs baseline"; spec updated in 6be9347).
- Orphaned CSS removed (old feed, notices, watchlist, result-header, metrics, etc.), each
  selector checked unused in `apps/web/src`; dynamic `relation-*`/`lean-*`/`explains-*` kept.
- Pure logic in `apps/web/src/backtest-model.ts` (tests: `tests/backtest-model.test.ts`);
  `outcomeLevels` in `chart-model.ts`; `groupAlertDays` gained the "run" sort.

## Verification

- `npm run check`: pass (178 tests: 177 pass, 1 skipped as before). `git diff --check`:
  clean.
- After the main merge: headless re-check (1280 and 390, synthetic mock) of the look-now
  card, verdict heading/"Baseline" labels/"vs baseline" differences, the meta line and the
  By-symbol "vs baseline" header; no horizontal page scroll.
- Headless Chrome against a SYNTHETIC mock API (kept outside the repo), desktop 1280 and
  phone 390: presets, Last 10 sessions dates, scenario 1 highlight/badge/title/Reset, run
  progress, verdict colours, a 503 batch → "2 issues" tab + pill warning → Retry these →
  totals updated and "1 gap", By symbol fading/order and row → filtered Alerts, expanded
  alert chart with levels, Best run sort, stale banner, client validation error, under-50
  note, "—" without `baselineBySymbol`, disabled Alerted recently, phone collapse and no
  horizontal page scroll (tables scroll in their box).
- Not verified: real Alpaca data, the real API/Worker with `baselineBySymbol`, Safari/iOS,
  screen readers. Screenshots were inspected but are not committed.

## Notes and open questions

- Dates show as "Sept" (ICU en-GB), the same as the Live day labels; the spec writes "Sep".
- Main now makes the look-now score the main grade and calls stop/target the "trade
  view"; this page shows both (look-now card first, then the verdict). Whether the verdict
  should be labelled or collapsed as the trade view is a Product+UX decision.
- The look-now card is main's existing component (older `.validation` styling, its own
  "random minutes" wording, which is accurate for that score).

## Next

Integration review and merge (the backend branch's commits are already included).
