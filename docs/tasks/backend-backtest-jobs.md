# Backend: backtest runs that go on when the phone leaves the page

Status: backend done on `claude/backtest-mobile-connection-issue-anf75r`; the page does not use it yet (Frontend).
Requested: 2026-11-04, user: "when I run [the backtest] from my phone I can't exit the page because it cancels the
connection with the results"; "but I do want to see progress and trades during the run".

## Cause

The page runs a backtest by itself (`apps/web/src/bot-backtest-run.ts`): it sends one request for each part (a
stock and up to 60 sessions), 4 at a time, from the browser. When a phone puts the page to sleep or drops it, the
requests in flight are cut off and no new part starts, so the run stops. The Worker also stops computing a part
whose request was cut off.

## Change

The server keeps and runs the whole run (`packages/market-data/src/backtest-jobs.ts`):

- The page sends the run once. The server stores it in D1 (`backtest_jobs`, `backtest_job_parts`,
  `backtest_job_results`) and puts each part on the Cloudflare Queue `sma-backtest-parts`. This Worker reads the
  queue (`queue()` in `apps/api/src/worker.ts`) one part per invocation, 4 at once, the page's old width.
- Each part is computed by the same handlers as `/api/bot-backtest` and `/api/volume-backtest`. Its response or its
  error is saved as soon as it finishes.
- The page reads the run as often as it likes, with `since`, and gets the progress and the new parts' trades while
  the run goes on. If it leaves and comes back, `latest` finds the run again.
- A part whose worker died (claimed over 16 minutes ago, still pending) is sent again by the every-minute cron.
- Runs are kept for a week, under the starter's Access email: another viewer neither sees nor stops them. Viewers
  may start runs, as they may use `/api/bot-backtest` (compute only).
- Local API (Fastify): the same store in the local SQLite file, with parts run in the process.
- A Worker without the queue binding (wrangler dev, tests) runs the parts after the response (`waitUntil`). That is
  best effort and would not finish a long run.

## Contract (for Frontend)

`POST /api/backtest-jobs`

```json
{ "bot": "main" | "volume",
  "parts": [{ "symbol": "AAPL", "from": "2026-01-02", "to": "2026-03-31" }],
  "body": { "rules": {}, "fillPct": 50 },
  "meta": { "...": "the page's Ran / VolumeRan, returned as is" } }
```

- `body` is what each part sends besides `symbol/from/to`: `{ rules, fillPct }` for main, `{ settings, fillPct }`
  for volume.
- Make the parts with `periodParts` as today (20 sessions a part for volume).
- At most 1000 parts. The request may be up to 256 KB, with `body` and `meta` up to 64 KB each.
- Answer: `201 { id, total }`. A bad request gets `400 { error }`.

`GET /api/backtest-jobs/:id?since=<ms>` and `GET /api/backtest-jobs/latest?bot=main|volume[&since=<ms>]`

```json
{ "id": "…", "bot": "main", "status": "running" | "done" | "stopped",
  "total": 80, "done": 12, "createdAt": 0, "updatedAt": 0, "lastDoneAt": 0,
  "meta": {},
  "results": [{ "index": 3, "doneAt": 0, "body": { "...": "BotBacktestResponse | VolumeBacktestResponse" } }],
  "errors": [{ "index": 5, "symbol": "NVDA", "from": "…", "to": "…", "error": "…" }],
  "stopped": null | { "done": 12, "total": 80 } }
```

- `done` counts failed parts too, which matches the page's `Busy.done`.
- `results` holds only the parts finished at or after `since`. Keep the largest `doneAt` you have seen and pass it
  next time, then add the results by `index`; one can come twice. `errors` is always the full list.
- `latest` answers `404` when the caller has no run of that bot.

`POST /api/backtest-jobs/:id/stop` answers with the run, `status: "stopped"`. No new part starts; the finished
parts stay.

### Suggested page change (`bot-backtest-run.ts`)

- `start`: POST the run, keep its `id` in `localStorage`, then poll every 2–3 s while `status === "running"`.
- On `visibilitychange` to visible, poll right away.
- On load, read `latest` for each bot, so a run started before a reload, or still running, is shown.
- `stop`: POST stop.
- Keep `RunState` as it is: `busy` comes from `done`, `total`, `createdAt` and `lastDoneAt`; `runs` comes from the
  results in index order; `errors` reads as "SYM from → to: error".

## Deploy step (once)

`npx wrangler queues create sma-backtest-parts`, before deploying this Worker. `wrangler.jsonc` binds it as
`BACKTEST_QUEUE` and consumes it.

## Validation

- `tests/backtest-jobs.test.ts` covers the input checks, parts finishing one by one and read with `since`, stop,
  a lost claim sent again, owner isolation, `latest`, the in-process runner, and the Worker's queue producer and
  consumer (synthetic parts; no market data).
- `npm run check` passes.
- Not run on Cloudflare: the queue has not been created, the code has not been deployed, and it has not been tried
  on a phone.

## Next

1. Frontend: switch `bot-backtest-run.ts` to these routes. Until then the page still runs parts itself.
2. Create the queue, then deploy from `main`.
