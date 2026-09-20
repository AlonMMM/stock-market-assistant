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

Detailed product architecture remains incremental; later entries supersede earlier pending choices.

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

## 2026-09-13 — Role sessions and worktree isolation

Status: confirmed by user.

Support parallel Claude Code sessions through `npm run session`. Each session has one explicit role, a dedicated `session/<id>` branch, a sibling Git worktree, and a non-overlapping web/API/E2E port block. The registry is local to the repository's common Git directory and is not product data.

The initial roles are Product + UX, Backend, Frontend, and Integration / Review. Product + UX owns user flows and alert semantics; Backend owns contracts, ingestion, alert evaluation, and persistence; Frontend owns the website and interaction states; Integration / Review owns cross-role wiring, verification, and release readiness.

## 2026-09-19 — IBKR data, up to 50 symbols

Status: confirmed by user; runtime choices are reversible implementation decisions.

Use existing IBKR API market-data entitlements for price and volume, initially up to 50
US stocks at minute close. The user uses only mobile and authorized us to handle setup.
Keep the existing private Sites replay site. Add a long-running Node collector beside
IB Gateway, using the pinned community TypeScript TWS adapter and SQLite on persistent
storage. No brokerage order or account-position operations are implemented. Runtime
provisioning awaits a connected cloud account and direct user IBKR authentication.

## 2026-09-20 — Browser Client Portal Gateway

Status: superseded after live validation.

Use IBKR's official Client Portal Gateway for browser SSO instead of publishing a remote
Linux desktop. Keep an independent HTTP authentication layer around the proxy. The user
enters brokerage credentials and completes 2FA only in IBKR's form. Authentication is
manual and normally required daily. Do not automate credentials.

The current TWS-protocol collector must remain disabled until its data adapter is replaced
with the Client Portal Web API and validated against the authenticated account. A second
IBKR username is the intended steady-state configuration so mobile trading and collection
can coexist; the primary username may be used temporarily by explicit user choice.

Live validation showed that publishing the login form through a public reverse proxy does
not satisfy IBKR's same-machine authentication restriction. The form loaded, but login
could not advance to 2FA. Do not restore this topology.

## 2026-09-20 — Graphical IB Gateway and TWS API

Status: confirmed by user; supersedes the Client Portal Gateway experiment.

Run the official IB Gateway on Railway and expose only a Basic-Auth-protected noVNC page
for interactive login from the user's phone. The graphical process and TWS API share the
same runtime; the collector connects privately and remains read-only. Never automate or
store brokerage credentials. A second IBKR username remains the intended steady state.

OAuth 2.0 is unavailable to Individual accounts. Third-party OAuth 1.0a requires IBKR
onboarding, compliance and legal approval and is not the immediate implementation path.
