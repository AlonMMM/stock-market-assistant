# Task: Backtest page redesign — spec and mockup

Status: completed
Owner: product-ux
Branch: session/product-ux-backtest-page
Spec/contract revision: this commit (docs/features/backtest-page.md)

## Outcome

An agreed, implementation-ready spec for the Backtest view in the Live redesign's style:
grouped setup with presets and change tracking, a verdict against random entries, and
Alerts / By symbol / Data quality tabs.

## Acceptance criteria

The spec lists layout, states, the additive `baselineBySymbol` contract and 10 acceptance
scenarios; the user approved the mockup on 2026-10-03.

## Dependencies and scope

[Spec](../features/backtest-page.md), [mockup source](../features/backtest-page-mockup/).
Backend: `session/backend-backtest-page`. Frontend: `session/frontend-backtest-page`.

## Verification and handoff

Docs only; Prettier and `git diff --check` run. The mockup logic was exercised with a Node
script; the canvas was not visually verified by the agent.
