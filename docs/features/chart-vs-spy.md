# Feature: Day chart vs SPY — score, price, colours

Status: agreed
Owner: product-ux
Spec revision: see git log for this file
Amends: [live-page](live-page.md) (day chart, watchlist) and [backtest-page](backtest-page.md)
(alert chart).

## User and outcome

When looking at any day chart, the trader wants to read at once how the stock is doing
against SPY: a single score, the price behind each percentage, and colours that mean
"stronger than SPY" (green) or "weaker than SPY" (red). The watchlist can be ranked by
that score.

## Changes (user-confirmed 2026-10-03)

Apply to the one shared day chart: Live alert rows, Watchlist rows, Backtest alert rows
and the market chart.

1. **Remove the entry, good and stop lines** from the chart. The Backtest trade-view
   outcome stays as text in the expanded row.
2. **Price next to every percentage**: the readout shows `NVDA +2.31% · $131.62` and
   `SPY +0.31% · $573.10` for the pointed or latest minute; each axis's last-value label
   shows the same pair when the chart library allows it, else % only.
3. **Colours of the opposite-to-benchmark bands, strip and summary chips**: "held while
   SPY fell" (stronger) is **green**; "fell while SPY held" (weaker) is **red**. The rule
   itself is unchanged. Text labels and ▲/▼ stay so colour is not the only cue.
   Volume bars keep their up/down colours; the band strip and chips carry their labels.
4. **Score vs SPY (0–100)**:
   - Chart header: "vs SPY score 72 / 100" for the latest minute; the readout shows the
     score at the pointed minute.
   - Watchlist table: a sortable "vs SPY score" column after "vs SPY | vs sector",
     default sort unchanged. Always against SPY, also when the table compares vs sector.
   - Readout of the score: 50 = moving like SPY × β; above 50 stronger, below weaker;
     tooltip/legend says so.

## Semantics

Same formula and parameters as the alert analysis relative-strength score
(`packages/analysis/src/relative-strength.ts`, user-confirmed 2026-09-28), applied to
"today so far":

- `excess = r_stock − β · r_SPY`, both % from the previous regular close to the minute.
- β = the 60-session daily beta vs SPY (as the day chart already uses); 1 when it
  cannot be estimated (then flagged "β assumed").
- σ = sample standard deviation of the stock's daily excess (close-to-close, same β)
  over the 20 sessions before the chart day; needs ≥ 15, else no score ("—").
- `score = round(clamp(50 + 10 · excess / σ, 0, 100))`.
- Pre-market minutes use the same formula (prices vs previous close); outside data
  coverage the score is "—".

## Contract needs

- One shared pure function (packages, Node-tested) computing the score from
  `(excessPct, sigma)` and reused by the analysis code so both stay identical.
- `POST /api/day-chart`: add `vsSpy: { beta: number; betaAssumed: boolean; sigma:
number | null }` for the requested ticker (against SPY even when the chart's
  benchmark is a sector ETF; then the response must also carry SPY's bars or the
  previous close and bars needed, choose the simplest additive shape and document it).
- `GET /api/board`: `stats.rsScore: number | null` (at `stats.asOf`, against SPY),
  plus `stats.beta`. Daily history for β/σ fetched once per day and cached like the
  volume baselines; no extra Alpaca calls on later polls.

## Acceptance scenarios

1. A Backtest alert chart shows no entry/good/stop lines; the expanded row still says
   "Trade view: Good in 12 min".
2. Hovering 17:15 shows `NVDA +1.92% · $131.05` and `SPY +0.28% · $572.40`.
3. A minute where SPY fell ≥ 0.05 pts over 5 min while the stock held is green with
   "▲ Holding while SPY falls"; the weak case is red with "▼ Falling while SPY holds".
4. Stock +2.31%, SPY +0.31%, β 1.5, σ 1.2 → excess 1.845, score round(50 + 15.4) = 65.
5. Excess 8, σ 1 → 100 (clamped); 14 of 20 sessions available → "—".
6. Watchlist sorted by "vs SPY score" puts "—" last; with "vs sector" selected the score
   column still compares to SPY.
7. The alert analysis score and the chart's score at the alert minute agree for the same
   inputs (shared function).

## Handoff

- **Backend** (`session/backend-chart-vs-spy`): shared score function (and switch the
  analysis code to it), day-chart `vsSpy`, board `stats.rsScore`/`beta` with caching,
  tests for scenarios 4, 5, 7.
- **Frontend** (`session/frontend-chart-vs-spy`): changes 1–3, score in chart header and
  readout, watchlist column; "—" when fields are absent.
