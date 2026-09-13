# Role-based local sessions

## First use

Use Node 24, Git, and an installed/authenticated Claude Code on PATH. From a committed checkout containing this launcher:

```sh
npm run session
```

Choose a role, then a short task name such as `alert-feed`. If saved sessions exist, choose one to resume or Enter to create a new one.
Roles: [Product + UX, Backend, Frontend, Integration / Review](roles/index.md).

The launcher creates a branch/worktree from **the current checkout's committed HEAD**. It never fetches or merges automatically. Update the intended starting branch yourself first. Uncommitted changes block creation so nothing is silently omitted.

## Shortcuts

```sh
npm run session -- --role product-ux --task alert-feed
npm run session -- --role backend --task alert-feed
npm run session -- --role frontend --task alert-feed
npm run session -- --role integration --task alert-feed
npm run session -- --list
npm run session -- --resume backend-alert-feed
```

Same role/task selects the existing worktree and retains its role. Different tasks get distinct worktrees, even with the same role. Resume does not reset, clean, or update the working tree.

To prepare without starting Claude (also works before Claude is installed):

```sh
npm run session -- --role backend --task alert-feed --prepare-only
```

Worktrees live beside the primary checkout under `<repository-name>-sessions/<role>-<task>`.
The launcher prints the exact path and URLs. In a second terminal in that worktree, run `npm ci` once, then `npm run dev` when needed. Dependencies are deliberately separate per worktree.
It also creates an initial `docs/tasks/<role>-<task>.md` for the session to define and maintain. Commit that task document with the work.

## Local state and concurrency

- Committed: role instructions, feature/task templates, and workflow.
- Local: `.sma-session.json` contains the role/task/ports and is ignored by Git.
- The shared Git directory contains `sma-sessions/` with worktree metadata, Claude UUIDs, and locks. No state is synced to another computer.
- A registry lock serializes new worktree/port allocation. A session lock prevents two launcher instances using the same worktree at once.
- Direct `claude` or manual Git operations do not use these locks. Keep one writer per worktree.
- Role boundaries are instructions, not OS or tool permissions.

## Ports

Each session reserves four available localhost ports starting at 5200: web, API, E2E web, E2E API. The allocator checks other registered sessions and current listeners.
Dev servers and browser tests use separate pairs. Their strict listeners fail if another process takes a port later; ports are not continuously reserved by open sockets.
Saved sessions keep their assigned ports. If a non-project process occupies one, stop your known process or deliberately adjust the local configuration; never kill unknown processes.

Outside a managed session, defaults are web 5173/API 3001 and E2E web 5174/API 3002.
Environment overrides: `SMA_WEB_PORT`, `SMA_API_PORT`, `SMA_E2E_WEB_PORT`, `SMA_E2E_API_PORT`. Environment values take precedence over `.sma-session.json`; use distinct pairs across concurrently running environments.

## Resume and recovery

The first launch passes a generated Claude session UUID and a small role/task prompt. After a clean exit, reopening uses `claude --resume <UUID>` without asking for the role again.
If Claude failed, was interrupted before saving a conversation, or its history was deleted, use:

```sh
npm run session -- --resume backend-alert-feed --fresh
```

This starts a new conversation with the same role, worktree, task, and ports. Existing transcripts and code are not deleted. It does not continue the old conversation.
If a crash leaves a lock, inspect its `owner.json` and confirm the process is no longer running before manually removing that specific lock directory. The launcher will not reclaim a lock automatically.
Missing worktrees and unexpected branches fail explicitly. Restore the worktree/branch before resuming; no cleanup or replacement happens automatically.
There is no automatic archive/removal operation yet; finished worktrees and port records remain until deliberately cleaned up.

## Direct Claude startup

CLAUDE.md tells Claude to use an explicit role or read local `.sma-session.json`. If neither exists, it asks for the role before substantive interactive work. This is a model instruction after interaction starts, not a guaranteed startup UI or a hook.

## Handoff between sessions

Each session owns its task document; Integration owns global state. Share a branch/PR plus the spec/contract commit ID. A peer must explicitly bring that revision into its branch; local sessions do not automatically exchange messages or files.

Claude CLI flags are documented in [Anthropic's CLI reference](https://code.claude.com/docs/en/cli-reference).
