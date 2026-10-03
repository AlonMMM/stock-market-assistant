# Task: Live page redesign — spec and mockup

Status: completed
Owner: product-ux
Branch: session/product-ux-live-page
Spec/contract revision: this commit (docs/features/live-page.md)

## Outcome

An agreed, implementation-ready spec for the Live page: status pill, market strip,
Alerts/Watchlist tabs, watchlist table with rel vol, and a two-axis day chart with typical
volume and opposite-to-benchmark bands.

## Acceptance criteria

The spec lists flows, states, semantics, API additions and 16 acceptance scenarios; the
user agreed the design on 2026-10-03.

## Dependencies and scope

[Spec](../features/live-page.md), [mockup source](../features/live-page-mockup/).
Backend: `session/backend-live-page`. Frontend: `session/frontend-live-page`.

## Verification and handoff

Docs only; `git diff --check` run. Mockup logic was exercised with a Node script during
design; the canvas was not visually verified by the agent. Open: colour overlap and the
divergence thresholds need review on real data. Integration updates docs/state.md.
