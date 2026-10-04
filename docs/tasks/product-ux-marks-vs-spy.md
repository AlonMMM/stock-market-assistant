# Task: Marked-sections score vs SPY — spec

Status: completed
Owner: product-ux
Branch: session/product-ux-marks-vs-spy
Spec/contract revision: this commit (docs/features/marks-vs-spy.md)

## Outcome

Agreed spec (user 2026-10-04): score vs SPY from the green/red marked minutes only, each sized by stock 5-min move minus beta x SPY 5-min move, linearly weighted over the 60 minutes before the alert, alert minutes excluded. Prototype on AVGO 3 Sep 22:50 (real SIP data) gave 73.

## Verification and handoff

Docs only; Prettier and `git diff --check` run. Backend: `session/backend-marks-vs-spy`; Frontend: `session/frontend-marks-vs-spy`.
