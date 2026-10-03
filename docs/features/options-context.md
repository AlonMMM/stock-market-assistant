# Feature: Options context on alerts

Status: proposed
Owner: product-ux
Spec revision: pending user agreement

## User and outcome

The user trades options. A stock alert answers "something is moving", but the decision is
which contract, and whether options are already pricing the move. Algo Trader Plus adds
real-time OPRA options data (consolidated quotes; up to 1,000 streaming quote
subscriptions; history only since February 2024).

Observable result: every tier-A alert (see [scoring](universe-and-scoring.md)) shows, in
Telegram and on the site, a compact options read: IV level and change, put/call activity,
and a few liquid candidate contracts in the alert's direction. It is decision support,
not a recommendation, and no orders are placed.

## Scope and exclusions

In scope: an options snapshot at alert time; candidate contracts; one Telegram line; an
options section in the alert detail; stored evidence.

Later, each needing an exact user definition: an **unusual options activity** alert family
(for example contract volume ≫ open interest, large premium, sweeps); IV rank or
percentile (needs an IV history Alpaca does not provide directly; computing it from option
bars only covers dates since Feb 2024); re-enabling options in the technical-scan skill.

Excluded: order entry; strategy P&L (see
[options strategy backtest](options-strategy-backtest.md)).

## Flow and states

- **Telegram (one line under the short follow-up):**
  `Options · IV 48% (+6 pts today) · P/C vol 0.6 · 18 Oct 190C 2.10×2.20 Δ0.42 OI 3.1k`
- **Site detail:** an IV block (ATM IV for the nearest standard expiries, change vs the
  previous close), put/call volume and premium today, and a table of 3–5 candidate
  contracts: expiry, strike, bid × ask, spread %, delta, theta, IV, volume, OI and a
  liquidity flag.
- **States:** `no listed options`; `illiquid options` (all candidates fail the liquidity
  rule, so the table shows them greyed out with the reason); `options data unavailable`
  (OPRA error; the alert itself is still delivered); a snapshot time shown in Israel time.
  A snapshot older than 60 s is labelled stale.

## Semantics and contract needs

Proposed defaults; the user's own trading preferences decide:

- **Snapshot time:** taken immediately after the alert bar closes; the stored snapshot is
  never refreshed silently (a later "refresh" is a separate, labelled snapshot).
- **Expiries:** the nearest expiry with DTE ≥ 7 and the next monthly. (Open question: your
  usual DTE.)
- **Candidates:** calls for an up alert, puts for a down alert; delta targets 0.30, 0.45 and
  0.60; the nearest strike to each target.
- **Liquidity rule:** spread ≤ 10% of mid and ≥ $0.05 wide max, OI ≥ 500, today's volume
  ≥ 100 (open question).
- **ATM IV:** the average IV of the call and put nearest the money at each expiry, from
  Alpaca's snapshot greeks/IV; if not provided, computed with Black-Scholes from mid.
- **IV change:** the current ATM IV minus the ATM IV from the previous session's last
  snapshot of the same expiry; null when not available (no substitution).
- **P/C:** put volume ÷ call volume across all expiries today, up to the snapshot.
- All option prices are labelled OPRA real-time; synthetic fixtures are labelled.

## Acceptance scenarios

1. An up alert on a ticker with liquid options shows calls only, with 3 deltas, each
   meeting the liquidity rule.
2. A ticker without listed options shows `no listed options`, and the rest of the
   follow-up is unchanged.
3. When the OPRA request fails, the alert and the analysis are still sent and the options
   line reads `options data unavailable`.
4. The snapshot time is shown in Israel time; the stored evidence keeps UTC.
5. The previous session's IV is missing, so IV change is blank, not 0.

## Decisions and handoff

Open questions: your typical DTE and delta; the liquidity thresholds; whether to cover
tier A only or all alerts (cost vs the 1,000-quote stream cap; snapshots via REST avoid
the cap); a definition of "unusual options activity" when you want that family.

Backend: OPRA snapshot client, candidate selection, stored evidence. Frontend: detail
section. Notifications: one line.
