# Task: Area score vs SPY — spec

Status: completed
Owner: product-ux
Branch: session/product-ux-area-vs-spy
Spec/contract revision: this commit (docs/features/area-vs-spy.md)

## Outcome

Agreed spec (user 2026-10-04): replace the day-based vs-SPY score and labels with a session-window, linearly weighted area score between the stock and beta-scaled SPY.

## Verification and handoff

Docs only; Prettier and `git diff --check` run. Backend: `session/backend-area-vs-spy`; Frontend: `session/frontend-area-vs-spy`.
