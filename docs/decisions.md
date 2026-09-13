# Decision log

## 2026-09-13 — Harness before product implementation
Status: confirmed by user.

Use AlonMMM/stock-market-assistant as the project repository. Establish the AI development harness before implementing the trading application.

## 2026-09-13 — Foundation structure
Status: initial implementation choice; reversible.

Use AGENTS.md as the canonical agent entry point, with a minimal CLAUDE.md pointer.
Store product scope, workflow, decisions, and handoff state in Markdown.
Use a dependency-free Python script to check the foundation; this does not select Python as the application language.

## Pending
Application stack, runtime harness, data provider, deployment, alert timing, and detailed product architecture remain undecided.
