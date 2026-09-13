# Development workflow

## Context loading
Start with AGENTS.md, state, and product scope. Load detailed files only when relevant.
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
- Harness now: context files and relative links; whitespace checks.
- First runtime: reproducible setup and actual run/check commands.
- First alert: positive, negative, boundary, repeated-event, and session-reset examples based on an approved rule contract.
- Historical replay: deterministic clock, no future data leakage, explicit data limitations.
- First UI: browser verification of the real user path and visual evidence.
- External services: synthetic fixtures by default; opt-in integration verification with secrets outside Git.
- CI: add the chosen runtime's checks when its toolchain is selected. No CI execution is claimed today.

## Extending the harness
Add tools or reusable workflows when a repeated task demonstrates the need.
Keep tool-specific entry points small and point them at the canonical instructions.
Record recurring failures and improve the relevant check or instruction; avoid accumulating overlapping rules.
