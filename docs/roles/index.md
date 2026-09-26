# Session roles

Roles describe ownership and expected outputs. They are not permission boundaries or autonomous teammates.
Load only the selected role's document in addition to AGENTS.md and current state.

| Role                                   | Owns                                                          | Primary output                                          |
| -------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| [Product + UX](product-ux.md)          | User problem, scope, flows, acceptance criteria               | Feature spec, interaction states, mockups               |
| [Backend](backend.md)                  | API, event processing, persistence when selected              | Implementation, deterministic tests, contract proposals |
| [Frontend](frontend.md)                | Web interface and interactions                                | Accessible UI, screenshots                              |
| [Integration / Review](integration.md) | Shared contracts, cross-cutting decisions, integration review | Review findings, verified integration, global state     |

## Shared agreement

- Every task has one owner and one task file. Same role can have multiple distinct tasks/worktrees.
- Roles may read the entire repository; editing outside a role's normal scope requires coordination with the affected owner.
- Product/UX proposals become accepted specifications only when the user agrees. Do not treat design exploration as permission to implement everything.
- Backend and Frontend use the same agreed contract commit. Route contract changes through Integration before dependent implementation.
- Each session updates its own task file. Integration maintains docs/state.md and cross-cutting decisions after reconciling handoffs.
- Exchange committed branches/PRs and exact spec/contract revisions. Other worktrees do not update themselves.
- Resolve shared-file conflicts explicitly; do not overwrite the other session's work.
- The human opens sessions; these role files do not automatically start other agents.

See [session launcher](../sessions.md) for isolated directories, ports, and resume behavior.
