# Task: Runnable TypeScript development harness

Status: implemented; browser verification pending.

## Outcome

A developer and coding agent can install, start, inspect, and verify the web/API foundation from one repository.

## Confirmed scope

TypeScript, React, Node.js, and local Claude Code were selected by the user. Implementation choices: npm, Vite, Fastify, Node tests, Prettier, and Playwright.
Market feeds, alert rules, charts, delivery, persistence, and hosting are excluded.

## Acceptance criteria

- Locked dependencies and Node version documented.
- One development command starts both services.
- Website validates a real API response and handles failure/retry.
- Type checks, API contract tests, and builds pass.
- Browser tests cover connection and recovery on a phone viewport.
- CI uses the same verification commands.
- Documentation contains actual commands and current state.

## Evidence

- `npm run doctor`: passed.
- `npm run check`: passed formatting, type checks, 2 API tests, and both builds.
- `npm ci --ignore-scripts --prefer-offline`: reproduced the locked install.
- `npm run test:e2e`: both servers started, but tests could not launch Chromium because the browser binary is unavailable here. Browser download timed out.
- `git diff --check`: passed.
- Browser rendering and assertions remain unverified locally. Check the CI run before merging.

## Handoff

See [development setup](../development.md) and [state](../state.md).
