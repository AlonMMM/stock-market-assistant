# Current state

Updated: 2026-09-13
Phase: harness foundation.

## Completed in this change
- Canonical agent instructions and a Claude entry point.
- Product requirements separated from proposed architecture.
- Development workflow, decision log, and task template.
- Dependency-free scaffold validation command.

## Verification
Run `python3 scripts/check_harness.py` and `git diff --check` from the repository root.
These are scaffold checks, not application tests. The delivery message records the actual run results.

## Next task
Agree on the primary local coding workflow and application stack, then create a minimal runnable development environment with documented startup and verification commands.
Do not begin implementing alert formulas before their specification is agreed.

## Open items
- No application runtime, data connection, CI, browser automation, or alert engine yet.
- No credentials required for the current foundation.
- See product.md for unresolved product decisions.
