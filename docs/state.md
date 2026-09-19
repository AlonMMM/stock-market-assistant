# Current state

Updated: 2026-09-19
Phase: First relative-volume replay implementation (2026-09-16).

## Relative-volume increment

The approved mobile mockup is now implemented as the replay homepage, with configurable cooldown, historical upload/reset, responsive evidence cards and proportional volume bars. See [design task](tasks/replay-mobile-design.md). Hosting and live data remain pending.

Implemented the [relative-volume contract](features/relative-volume.md): deterministic minute-bar engine, same-time historical median, crossing/cooldown suppression, replay API, synthetic demo and historical JSON upload UI. Run npm run dev, then Run replay. No live data credentials are required.

Verification: npm run check passed (12 tests, types, formatting, build). Local browser suite could not launch because Chromium is missing; CI must verify the three browser tests. Price charts, live feed, phone delivery and durable storage remain pending. Next: choose a data provider and implement calendar-aware normalization and data-quality checks before live monitoring. Only task-planner and reviewer agents are authorized; neither was added in this increment.

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

Run the replay UI and evaluate relative-volume thresholds; select the live/historical provider next.

## Not implemented

Live market data, charts, phone delivery, persistence, and deployment.
