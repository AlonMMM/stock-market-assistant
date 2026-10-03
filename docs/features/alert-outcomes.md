# Feature: SIP feed and alert outcome tracking

Status: proposed
Owner: product-ux
Spec revision: pending user agreement

## User and outcome

The trader needs to know whether alerts are worth acting on. Today the only evidence is a
one-off validation (decisions.md, 2026-09-27: 32% "good momentum" vs a 30% baseline on
IEX-era thresholds), and live volume is IEX only. With Algo Trader Plus the collector can
use full-market SIP volume, and every alert can be scored automatically against what the
price did next.

Observable result: each alert in the site and in the backtest shows what happened after
it, and a scorecard shows hit rate and follow-through per horizon, compared with a
baseline, so thresholds are tuned from evidence.

## Scope and exclusions

In scope:

1. Live feed switch from IEX to SIP, with the feed recorded on every stored alert.
2. Re-baselining the RVOL v3 defaults on SIP via the existing backtest.
3. Outcome metrics for every live and backtest alert, computed by one shared function.
4. A scorecard view (site) and an outcome line in the alert detail.

Excluded: P&L, position sizing, fills or costs (see
[options strategy backtest](options-strategy-backtest.md)); automatic threshold changes;
outcomes for synthetic alerts beyond labeled demos.

## Flow and states

- **Feed row:** after its horizons pass, each alert shows a compact outcome chip, e.g.
  `15m +0.8% ✓` (signed in the alert's direction). Before then: `pending · 15m at 18:37`
  (Israel time). Missing bars: `no data`. A cue that does not rely on colour alone (✓ / ✗ /
  – plus text).
- **Alert detail:** a small table of horizons (5, 15, 30, 60 min, session close) with the
  signed return, the return in excess of SPY × β, and the 60-minute max favourable /
  adverse excursion. A `session ended` flag when a horizon runs past the session.
- **Scorecard (new tab, desktop and phone):** filters for date range (US session dates),
  feed, rule version, ticker, volume basis (history / pace), session (pre / regular /
  post), hour (Israel time) and, later, score tier. It shows the number of alerts, hit
  rate and median signed return per horizon, next to the baseline. With fewer than 30
  alerts in a cell it shows `too few alerts`, not a percentage.
- **States:** loading; empty (`no alerts in range`); stale (collector disconnected, so
  outcomes are not updating, with the last update time); IEX and SIP mixed in the range
  (warn and default to one feed).
- A permanent label: "Signal follow-through, not trading profit."

## Semantics and contract needs

All proposed defaults below need user approval.

- **Reference price:** the alert bar's close (what the alert shows). Also record the next
  bar's open as the earliest realistic entry, because the phone receives the alert after
  the bar closes.
- **Horizons:** 5, 15, 30 and 60 minutes after the alert bar's end, plus the regular
  session close. Same session only; a horizon past the session end uses the last bar and
  is flagged.
- **Signed return:** r × (+1 for an up alert, −1 for a down alert).
- **Excess return:** signed (r_stock − β · r_SPY), with β from the
  [alert analysis](alert-analysis.md) definition (60 sessions, β = 1 when assumed).
- **MFE / MAE:** the best and worst signed close-to-reference move within 60 minutes.
- **"Hit" (open question):** the repository does not record how "good momentum" was
  defined in the 2026-09-27 validation. The proposed default is that the 15-minute signed
  excess return is > 0. Alternatives: MFE ≥ the alert's own move before MAE ≤ −½ move; or a
  fixed % target. The user picks one, and it is versioned.
- **Baseline:** same tickers and dates, random eligible minutes (same sessions, after the
  4th bar), whose direction is taken from that minute's own last-3-bar direction, measured
  identically. Seeded so reruns match.
- **Feed:** each alert stores `feed: "iex" | "sip"`. The scorecard never mixes feeds
  silently.
- **Data:** SIP one-minute bars from the collector store (live) or Alpaca history
  (backtest). Bars after the alert are read only for outcomes, never for the alert itself.

### SIP switch and re-baseline

1. Set `ALPACA_FEED=sip` once the plan is active. Validate the 406 single-connection rule
   and the subscription state as in [operations](../alpaca-operations.md).
2. Backtest the 50-symbol watchlist over the last 20 sessions with the current defaults.
   Report alerts per day, phone pushes per day and hit rate against the baseline.
3. Revisit `minVolume` (decision 2026-09-27 notes it was stricter on IEX) and
   `threshold`/`priceMultiple` only with that evidence. The user approves any change.

## Acceptance scenarios

1. An up alert at bar close 100.00, followed by a close of 100.80 15 minutes later, shows
   `15m +0.8%`; a down alert with the same prices shows `15m −0.8%`.
2. An alert at 22:50 Israel time (10 minutes before the US close in summer) reports 30m and
   60m as `session ended`, using the 23:00 bar.
3. An alert whose 15-minute horizon has not passed shows `pending` with the due time in
   Israel time; after it passes, the value appears without a page reload or on the next
   refresh.
4. A missing bar at the horizon uses the last bar at or before it and never a later one;
   if there is none in the session, it shows `no data`.
5. A scorecard filtered to a ticker with 12 alerts shows counts but `too few alerts` in
   place of rates.
6. A range containing IEX and SIP alerts warns and defaults to SIP.
7. A backtest of the same days as live produces identical outcome values for the same
   alert (shared function).
8. A synthetic alert never appears in the scorecard.

## Decisions and handoff

Open questions for the user:

- Which "hit" definition?
- Which horizons matter for your options trades? Is 5–60 min plus session close right?
- The acceptable phone pushes per day after the SIP switch, so the re-baseline can be
  tuned towards it.

Dependencies: Algo Trader Plus active; Backend (outcome function, storage, API);
Frontend (feed chip, detail table, scorecard); Integration (contract, state).
