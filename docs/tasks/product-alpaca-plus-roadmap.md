# Task: Product roadmap for Alpaca Algo Trader Plus

Status: active — specs proposed, awaiting user decisions
Owner: product-ux
Branch: ccr-da531370-bvx3lr
Spec/contract revision: pending

## Outcome

Turn the move to Alpaca Algo Trader Plus (SIP stocks, OPRA options, unlimited stock
stream symbols, 10,000 requests/min, options history since Feb 2024) into agreed,
implementable feature specs.

## Scope and exclusions

User-selected on 2026-10-03, in proposed order:

1. [SIP feed and alert outcome tracking](../features/alert-outcomes.md)
2. [500-ticker universe and alert scoring](../features/universe-and-scoring.md)
3. [Options context on alerts](../features/options-context.md)
4. [Options strategy backtest](../features/options-strategy-backtest.md) (discovery; the
   user's strategy is not yet defined)

Not selected now: new alert families (bid/ask, halts, breakouts, news+volume), live
charts, a market dashboard.

## Relevant context

[Product scope](../product.md), [relative volume](../features/relative-volume.md),
[alert analysis](../features/alert-analysis.md), [operations](../alpaca-operations.md),
decisions.md 2026-09-27.

## Acceptance criteria

Each spec moves to `agreed` once the user answers its open questions; Integration
records the decisions and hands off Backend and Frontend tasks.

## Plan and assumptions

- Outcome tracking comes first: scoring calibration and strategy evaluation depend on it.
- Alpaca plan facts were checked via a web search on 2026-10-03; the docs site was not
  reachable from the session. Whether historical options quotes exist must be verified.
- Real-time SIP/OPRA under a personal plan is assumed to be for the user's own use; a
  multi-user site needs a redistribution review first.

## Verification evidence

Documentation only; no code changed.

## Handoff

Next action: the user answers the open questions, starting with alert-outcomes.md ("hit"
definition, horizons, push budget) and the six strategy questions.
