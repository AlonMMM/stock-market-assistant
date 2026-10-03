# Task: Day chart vs SPY — spec

Status: completed
Owner: product-ux
Branch: session/product-ux-chart-vs-spy
Spec/contract revision: this commit (docs/features/chart-vs-spy.md)

## Outcome

Agreed spec for four chart changes requested on 2026-10-03: no entry/stop lines, price
next to %, green = stronger / red = weaker than SPY, and a 0–100 score vs SPY on charts
and in the watchlist.

## Verification and handoff

Docs only; Prettier and `git diff --check` run. Backend: `session/backend-chart-vs-spy`;
Frontend: `session/frontend-chart-vs-spy`.
