# Current state

Updated: 2026-09-13
Phase: Role-based TypeScript development harness.

## Confirmed choices

- TypeScript throughout; React web and Node.js backend.
- Primary workflow: Claude Code on the user's computer.
- Parallel workflow: one Claude session per role, isolated in its own Git worktree and port block.

## This milestone

- Local web/API startup with a shared health contract, visible connection state, and retry.
- Locked npm installation, strict TypeScript, formatting, API tests, browser tests, and build commands.
- Setup/troubleshooting documentation and CI configuration.
- Smaller mandatory agent context; details loaded by task.
- `npm run session` launcher with Product + UX, Backend, Frontend, and Integration / Review roles.
- Role-specific task templates, handoff rules, and resumable session registry.

## Verification

Local formatting, TypeScript, 8 tests, and builds passed. Browser tests started both servers but could not launch the missing Chromium binary; downloading it timed out. Both browser tests passed in [GitHub CI](https://github.com/AlonMMM/stock-market-assistant/actions/runs/34737992056). Manual visual review remains outstanding. See [task evidence](tasks/runtime-harness.md), [role-session evidence](tasks/role-sessions.md), and [development](development.md).

## Next task

Run `npm run session -- --role product-ux --task first-alert-contract` on the user's Mac. Define the first alert contract with positive/negative examples, then hand it to Backend and Integration before implementing alert logic.

## Not implemented

Market data, alert formulas, charts, phone delivery, persistence, and deployment.
