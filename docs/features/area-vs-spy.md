# Feature: Area score vs SPY

Status: agreed
Owner: product-ux
Spec revision: see git log for this file
Replaces: the day-based vs-SPY score and its direction labels from
[alert-vs-spy](alert-vs-spy.md) and [chart-vs-spy](chart-vs-spy.md) (user decision
2026-10-04). The analysis follow-up's own relative-strength score is unchanged.

## User and outcome

The trader wants one number that says how the stock has been behaving against SPY in
this session, judged by the shape between the two curves (the green and red areas), with
the minutes closest to the alert counting most. The old day-based score marked a NVDA ▼
alert at 17:47 on 28 Sep as "against" although the drop moved with SPY; that score and
its labels are removed.

## Definition (user-agreed shape; parameters agreed 2026-10-04)

For a symbol, a session date and an end minute T (the alert's bar close, or the latest
bar when there is no alert):

- **Window**: from the first bar of the session that contains T (regular session from
  09:30 New York; pre-market from its first bar; after-hours from 16:00) through T. Same
  session for the stock and SPY.
- **Base**: both series at 0 at the window start: `s(t) = close_stock(t) / open_stock(t0)
− 1` and `m(t) = close_SPY(t) / open_SPY(t0) − 1`, in %; `open(t0)` is the open of the
  first bar of the window. Missing minutes carry the last close forward (not before the
  first bar).
- **Gap**: `gap(t) = s(t) − β · m(t)`, β = the existing 60-session daily beta vs SPY
  (1 and flagged when unknown).
- **Weight**: linear ramp `w(t) = (t − t0 + 1) / (T − t0 + 1)` per minute.
- **Area**: `A = Σ w(t) · gap(t) / Σ w(t)`, in % points.
- **Scale**: σ = root mean square of A computed the same way for the same symbol at the
  same New York minute and session over the previous 20 sessions (needs ≥ 15).
- **Score**: `round(100 · Φ(A / σ))`, Φ = standard normal CDF. 50 = normal, ≥ 60 green
  (stronger than SPY), ≤ 40 red (weaker), between grey. Null ("—") without σ, without
  SPY data, for SPY itself, or for the first 5 minutes of a window (too short).
- No future data: everything at T uses bars closed at or before T.

## Where it appears

- **Telegram alert**: the vs-SPY line becomes `vs SPY 72/100` (no labels); `vs SPY —`
  when null.
- **Site alert rows (Live and Backtest)**: the vs-SPY cell shows the score with its
  colour (green/red/grey) and the words "stronger" / "weaker" / "normal" in the
  accessible label and tooltip; the expanded line "vs SPY at alert 72 → now 64 ↓ · β 2.0"
  stays (the "now" value is the area score ending at the latest bar).
- **Day chart**: header "vs SPY 72 / 100" (ending at the latest bar, or at the alert for
  alert charts' "Around alert" view at the alert minute); readout "Score N" for the
  pointed minute (area ending there). New small pane under the price pane: the gap(t)
  curve with fill green above 0 and red below, a zero line, and a faint ramp showing the
  weight; the existing 5-minute opposite-to-SPY bands stay.
- **Watchlist**: the "vs SPY score" column uses the area score ending at the board's
  as-of minute.
- **Backtest**: alerts carry the area score at alert time.
- Remove the "confirmed / against / market" labels and their legend text everywhere.

## Contract needs

- One shared pure function in packages computing `{ area, sigma, score }` from minute
  bars of the stock and SPY, β, and the 20-session history (also exposing the per-minute
  gap and score series for the chart). Node-tested. The label function and its constants
  are removed (or deprecated if a stored alert still references them; old alerts with a
  label still render the score only).
- Alert `vsSpy` becomes `{ score, area, beta, betaAssumed, spyLagged }` (label dropped;
  old records may carry it and must still parse).
- σ needs 20 sessions of minute bars for the stock and SPY at the same minute: the
  collector already loads warmup minute history; cache σ per (symbol, date, minute) or
  compute the 20 historical areas once per day per symbol as a per-minute σ curve, like
  the volume baselines. Document cost.
- Board `stats.rsScore` → the area score; day chart supplies what the web needs to draw
  the gap pane and per-minute scores (σ curve per minute for the requested session, or
  precomputed series).

## Acceptance scenarios

1. Stock and SPY move identically with β 1 → gap 0 everywhere → score 50.
2. Stock 1 pt above β·SPY for the whole window, σ 1 → score round(100·Φ(1)) = 84.
3. Same gap only in the last 10 of 60 minutes vs only in the first 10 → the late case
   scores higher (linear weight).
4. NVDA-like case: stock above β·SPY most of the session, a final 3-minute drop that
   matches β·SPY's drop → score stays high (the drop adds ~0 gap).
5. 14 of 20 prior sessions available → "—".
6. Alert in pre-market → window starts at the pre-market's first bar.
7. The Telegram line, site tag and chart header show the same number for the alert
   minute.
8. No labels ("confirmed", "against", "with market") appear anywhere.

## Handoff

- **Backend** (`session/backend-area-vs-spy`): shared area function and σ history/cache,
  collector alert score + `strengthNow`, Telegram line, board and day-chart data, backtest;
  tests for scenarios 1–6.
- **Frontend** (`session/frontend-area-vs-spy`): tags without labels, chart header and
  readout, the gap pane, watchlist column; tests for display logic; scenario 7–8 checks.
