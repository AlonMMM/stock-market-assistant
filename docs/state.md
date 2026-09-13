# Current state

Updated: 2026-09-13
Phase: TypeScript development harness.

## Confirmed choices

- TypeScript throughout; React web and Node.js backend.
- Primary workflow: Claude Code on the user's computer.

## This milestone

- Local web/API startup with a shared health contract, visible connection state, and retry.
- Locked npm installation, strict TypeScript, formatting, API tests, browser tests, and build commands.
- Setup/troubleshooting documentation and CI configuration.
- Smaller mandatory agent context; details loaded by task.

## Verification

Local formatting, TypeScript, 2 API tests, and builds passed. Browser tests started both servers but could not launch the missing Chromium binary; downloading it timed out. Browser assertions and visual rendering remain unverified locally. See [task evidence](tasks/runtime-harness.md) and [development](development.md).

## Next task

Run the environment on the user's Mac. Then define the first alert contract with positive/negative examples and decide data resolution before implementing alert logic.

## Not implemented

Market data, alert formulas, charts, phone delivery, persistence, and deployment.
