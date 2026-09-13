# Shared project instructions

Read and follow [AGENTS.md](AGENTS.md) before working on this repository.
It is the canonical project instruction source; do not duplicate its rules here.

## Session role

Use the role explicitly supplied for this session. Otherwise, if `.sma-session.json` exists, read its role and task. Load only `docs/roles/<role>.md` for that role, then the assigned task document.
If no role is known in an interactive conversation, make the first assistant response ask once before substantive work: “באיזה כובע עובדים בסשן הזה — Product + UX, Backend, Frontend או Integration / Review?” The repository-level SessionStart hook reinforces this behavior; it does not affect Claude sessions started elsewhere.
Keep the chosen role for the conversation; do not ask again on each prompt or after resuming. An explicit user role change takes precedence.
For an unattended task with no role, infer the narrowest suitable role and state the assumption instead of blocking for input.
Choosing a role alone does not create worktree isolation; `npm run session` does. See docs/sessions.md when relevant.
