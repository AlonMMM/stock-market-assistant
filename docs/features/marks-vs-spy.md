# Feature: Marked-sections score vs SPY

Status: agreed
Owner: product-ux
Spec revision: see git log for this file
Replaces: the area score of [area-vs-spy](area-vs-spy.md) everywhere it is shown (user
decision 2026-10-04). Uses the opposite-to-benchmark marks of
[live-page](live-page.md#semantics-and-contract-needs) (`opposite()`), unchanged.

## Why

On real alerts (AVGO 3 Sep 22:50, HPE 21:31) the area since the open was dominated by
the morning and did not reward the stock's behaviour against SPY just before the alert.
The user wants the score built only from the green/red marked sections, sized by how
much the stock diverged from SPY, weighted toward the alert.

## Definition

For a symbol and an end minute E (regular session; same rules for stock and SPY):

- **End minute**: for an alert, E = the last minute **before** the alert's own window
  (alert bar end minus `config.window` minutes), so the alert's own move is excluded;
  without an alert (chart latest, watchlist), E = the latest closed bar.
- **Marks**: the per-minute states of `opposite()` (green "held while SPY fell", red "fell
  while SPY held"), with its existing thresholds and no-future-data rules. Only minutes
  i ≤ E with a state count; unmarked minutes contribute 0.
- **Contribution** of a marked minute i: `c(i) = tR(i) − β · bR(i)`, with tR, bR the
  stock's and SPY's 5-minute moves (% points from previous close, as in `opposite()`)
  and β the 60-session daily beta vs SPY (1 and flagged when unknown). Green marks give
  positive c (larger when SPY fell more, and more so with high β); red marks negative c.
  A marked minute whose c has the opposite sign of its colour (possible with β) still
  counts with its computed c.
- **Weight**: linear over the last 60 minutes up to E: `w(i) = (60 − (E − i)) / 60` for
  0 ≤ E − i < 60, else 0. The newest minute weighs 1.
- **Sum**: `I = Σ w(i) · c(i)` over marked minutes (% points).
- **Scale**: σ = RMS of I computed the same way at the same New York minute over the
  previous 20 sessions (≥ 15 needed; sessions with no marks count as I = 0).
- **Score**: `round(100 · Φ(I / σ))`. No marks in the hour → I = 0 → 50 (grey). Green ≥
  60, red ≤ 40. Null ("—") without σ (or σ = 0), without SPY data, for SPY itself, outside
  the regular session (marks are regular-session only), or before marks can exist (first
  ~20 minutes after the open, as `opposite()` needs 15 moves for red; green may appear
  earlier — score is computed as soon as σ exists).

## Display

Same places as the area score (Telegram `vs SPY 72/100`, alert tags on Live and
Backtest, "at alert → now" line, chart header and readout, watchlist column), same
colours, no labels.

Day chart: the "Gap vs β×SPY" pane is replaced by a **contributions pane**: one bar per
marked minute, height c(i), green above 0 / red below, opacity by weight w(i) relative to
the header's end minute (fainter = older), with the 60-minute weight window shaded and,
for alert charts in "Around alert", a marker for the excluded alert window. The light
bands and strip stay. Legend text explains: "score = marked minutes only, each sized by
the stock's 5-min move minus β × SPY's, recent minutes weigh more, the alert's own minutes
excluded; 50 = normal".

## Contract needs

- Shared pure module replacing the area computation: per-minute contributions and
  marks, I and score at a given end minute, per-minute score series for charts, σ curve
  per minute from 20 prior sessions. Reuse `opposite()`; Node tests.
- Alert `vsSpy`: `{ score, sum, beta, betaAssumed, spyLagged }` (`sum` = I; old records
  with `area`/`label` still parse). `strengthNow` unchanged in shape.
- Day chart: replace `areaVsSpy` with a series carrying per-minute `contribution`
  (null when unmarked), `weightEnd`-independent data the web needs, and per-minute
  `score`; board `stats.rsScore` = this score at as-of. Keep the Worker subrequest budget
  (≤ 40 per request, existing test) and the σ caches (rename/replace `area_sigma`).
- Backtest alerts carry the new score; bump the code-version sources.

## Acceptance scenarios

1. No marks in the 60 minutes before E → score 50.
2. One green mark 1 minute before E, SPY −0.50 / stock 0 / β 2 → c = +1.00, w ≈ 1;
   the same mark 50 minutes before E → w ≈ 0.18; the first scores higher.
3. SPY −0.05 vs −0.50 with the stock flat (β 1) → contributions 0.05 vs 0.50.
4. A ▼ alert whose own 3 minutes form a red mark: that mark is excluded; earlier green
   marks decide (AVGO 3 Sep 22:50 → green, ~73 on real data in the prototype).
5. Marks older than 60 minutes before E contribute 0.
6. 14 of 20 prior sessions → "—"; pre-market alert → "—".
7. Telegram, alert tag and chart header (at the alert's E) show the same number.

## Handoff

- **Backend** (`session/backend-marks-vs-spy`): shared module, σ curves and caches,
  collector alert score and `strengthNow`, Telegram, day-chart and board data, backtest;
  tests for 1–6 and the subrequest budget.
- **Frontend** (`session/frontend-marks-vs-spy`): contributions pane replacing the gap
  pane, legend/notes, header/readout at the right end minute; tests; scenario 7 check.
