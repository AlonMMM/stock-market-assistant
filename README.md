# Stock Market Assistant

A trading support product starting with configurable alerts, sector/index context, phone notifications, and historical replay.

Current milestone: **runnable TypeScript development harness**. The React page checks the Node API connection. Market data, alert rules, charts, and notifications are not implemented.

## Run locally

Requires Node.js 24 and Git. With nvm already installed, `nvm install` selects the version in `.nvmrc`.

```sh
npm ci
npm run doctor
npm run dev
```

Open http://127.0.0.1:5173. Both servers run in the terminal; Ctrl+C stops them.

## Verify

```sh
npm run check
npx playwright install chromium
npm run test:e2e
```

Stop `npm run dev` before E2E: the tests start their own servers on ports 3001 and 5173.

## Work with Claude Code

Run `claude` from the repository root. `CLAUDE.md` points to the canonical [AGENTS.md](AGENTS.md).
Start a task with: “Read AGENTS.md and docs/state.md, inspect the repo, and implement the next agreed task with verification.”
Keep decisions in the repository so work can continue in another session or coding tool.

## Context map

- [Current state](docs/state.md)
- [Development setup, commands, and troubleshooting](docs/development.md)
- [Product requirements](docs/product.md)
- [Decision log](docs/decisions.md)
- [Workflow](docs/workflow.md)
- [Task template](docs/task-template.md)

## Structure

- `apps/web`: React + Vite.
- `apps/api`: Fastify + TypeScript.
- `packages/contracts`: shared health-response type and runtime validation.
- `tests`: API contract checks and browser integration checks.
- `scripts`: developer environment/context checks.

The repository uses one npm package and lockfile. No monorepo orchestrator, database, provider account, or secret is needed at this stage.
