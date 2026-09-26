# Development environment

## Setup on a Mac

1. Install Git and Node.js 24. If using nvm, run `nvm install` in the repository.
2. Clone `https://github.com/AlonMMM/stock-market-assistant.git` and enter the directory. Check out the task branch if it has not been merged.
3. Run `npm ci` using the committed lockfile, then `npm run doctor`.
4. Run `npm run dev`. Open http://127.0.0.1:5173.
5. In another terminal in the same repository, start Claude Code with `claude`.

No environment file, cloud account, API key, or Python installation is needed for the normal workflow.

## Claude Code on the web

`.claude/hooks/cloud-setup.sh` runs at session start only when `CLAUDE_CODE_REMOTE=true`. It installs the `.nvmrc` Node version through nvm when needed, and runs `npm install`. Local sessions skip it.

`.claude/settings.json` also pre-approves the verification commands, asks before force-pushes and IBKR order instructions, and blocks reading or editing `.env` files.

## Commands

| Command             | Purpose                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `npm run dev`       | Start API and web with reload; stops the other process if one exits |
| `npm run doctor`    | Check Node/Git, installed dependencies, and context links           |
| `npm run check`     | Formatting, TypeScript, API tests, and builds                       |
| `npm run format`    | Apply formatting                                                    |
| `npm test`          | API/client contract tests without opening a network port            |
| `npm run build`     | Compile API to `dist/` and web to `dist/web/`                       |
| `npm run start:api` | Run the compiled API after building                                 |

## Runtime boundaries

The API listens on `127.0.0.1:3001`; Vite listens on `127.0.0.1:5173` and proxies `/api` to it.
The web page validates `/api/health`, handles failures/timeouts, and supports retry.
The API status explicitly says market data is not connected.
These localhost defaults are for development. The built frontend is not automatically served by the API; deployment needs a separately agreed hosting/proxy setup.

## Debugging

- API logs appear under `api` in the dev terminal; web compilation errors under `web`.
- If a port is occupied, stop the known dev process. Do not kill unknown processes blindly.
- If the UI says unavailable, inspect API logs and request `http://127.0.0.1:3001/api/health`.
- Node version mismatch: use `.nvmrc`, then reinstall with `npm ci`.

## Validation scope

The checks establish reproducible setup, contract compatibility, and builds.
They do not validate browser behavior (no automated browser tests currently), trading logic, market-data accuracy, delivery latency, or production readiness.

## Tool references

- [Vite](https://vite.dev/)
- [Fastify](https://fastify.dev/)
