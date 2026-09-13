# Development workflow

## Context loading

Start with AGENTS.md and current state. Load product scope, setup, decisions, and detailed workflow only when relevant to the task.
Repository files hold durable context; session summaries are a convenience, not the source of truth.
Document conflicting or stale information instead of silently picking an interpretation.

## Task loop

1. Inspect existing code and working-tree changes.
2. Define the outcome, exclusions, and observable acceptance criteria. Use the task template for substantial work.
3. Resolve only decisions that block this task. Record assumptions and proposals explicitly.
4. Implement a small reviewable change. For subsequent work, create a task branch.
5. Run verification proportional to the risk. Add meaningful behavior tests when implementing logic; do not invent passing product tests for an empty scaffold.
6. Review the diff for correctness, scope, secrets, and unsupported completion claims.
7. Update state and relevant documentation, commit the intended files, and report evidence.

## Verification as the application grows

- Harness now: `npm run doctor` for environment/context; whitespace checks.
- Runtime now: `npm ci`, `npm run dev`, and `npm run check`; see development.md.
- First alert: positive, negative, boundary, repeated-event, and session-reset examples based on an approved rule contract.
- Historical replay: deterministic clock, no future data leakage, explicit data limitations.
- UI now: `npm run test:e2e` covers real API connectivity and failure/retry. Extend it for future user paths.
- External services: synthetic fixtures by default; opt-in integration verification with secrets outside Git.
- CI: the runtime workflow installs locked dependencies and runs checks plus browser tests. Verify a run's result before claiming it passed.

## Extending the harness

Add tools or reusable workflows when a repeated task demonstrates the need.
Keep tool-specific entry points small and point them at the canonical instructions.
Record recurring failures and improve the relevant check or instruction; avoid accumulating overlapping rules.
