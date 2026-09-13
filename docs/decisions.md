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

Data provider, deployment, alert timing, and detailed product architecture remain undecided.

## 2026-09-13 — TypeScript and local Claude Code

Status: confirmed by user through setup choices.

Use TypeScript throughout, React in the website, and Node.js in the server. The primary local workflow is Claude Code on the user's computer.

## 2026-09-13 — Minimal runnable harness

Status: implementation choice; reversible.

Use Node.js 24, npm with a committed lockfile, React/Vite, and Fastify.
Keep one root package with separate app directories and a small shared contract module.
Use TypeScript checks, Node tests via tsx, Prettier, and Playwright for real browser/API feedback.
No database or data provider is selected. The connection screen is a development smoke path, not the trading dashboard design.
The Node doctor replaces Python as the normal scaffold verification entry point; the original Python script remains available for the initial context checks.

## 2026-09-13 — Load context by task

Status: implementation choice following the discussion of token overhead.

Start with AGENTS.md and current state. Load product/workflow/decision documents when relevant, instead of requiring all documents on every task. This reduces mandatory context; no token savings have been measured.
