# Task evidence: role-based Claude sessions

Status: completed
Owner: integration
Branch: feat/role-sessions
Spec/contract revision: role launcher and session docs

## Outcome

The repository can start, resume, list, and refresh isolated Claude Code sessions by explicit role. Each session receives a dedicated worktree, branch, task file, and port block.

## Verification evidence

- `npm run format` — passed.
- `npm run doctor` — passed with the role and session documentation present.
- `npm run check` — passed: formatting, TypeScript, 8 tests, and API/web builds.
- `tests/session.test.mjs` — covers parser safety, isolated worktrees and ports, lock behavior, dirty-source refusal, unknown resume refusal, first launch, exact UUID resume, and `--fresh`.
- `tests/ports.test.ts` — covers session-file and environment-based port resolution.
- Direct `claude` startup is repository-scoped through `.claude/settings.json` and `scripts/session-start.mjs`; managed sessions carry the role and skip the question.

## Handoff

Use `npm run session -- --role product-ux --task <short-name>` to begin the next product task. When implementation is ready, use the Integration / Review role to run the full check suite and update `docs/state.md`.
