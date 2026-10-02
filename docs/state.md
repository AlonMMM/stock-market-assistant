# Current state

Updated: 2026-10-02 (reconciled PRs #18–#31)
Phase: live relative-volume alerts with Telegram delivery and per-alert analysis.

## Working product

- **Website** (Cloudflare Worker, invite-only through Cloudflare Access; see
  [deploy task](tasks/backend-cloudflare-deploy.md)). Live is the home page: market chart,
  warnings stack, watchlist board and the collector's alerts grouped by Israel date, with
  each alert's analysis panel and charts. Backtest runs Alpaca SIP history through the
  live evaluator for up to 40 watchlist symbols, with a compact feed, per-alert day chart
  (overlay or % vs SPY×β) and momentum validation against a baseline. Replay mode was
  removed from the site; `/api/replay` remains for tests.
- **Collector** (Railway `market-collector`): Alpaca historical warmup plus one live
  WebSocket of closed minute bars (IEX by default), SQLite store, protected health,
  alert, watchlist, notification and analysis endpoints. The watchlist is synced from
  the user's IBKR "Favorites" list (read-only) with a sector benchmark per symbol; see
  [watchlist sync](ibkr-operations.md#watchlist-sync).
- **Alert rule:** relative volume v3 with the last-minute gate off by default. See
  [relative volume](features/relative-volume.md) and [decisions](decisions.md).
- **Bar cache:** Alpaca minute bars per symbol and day in Cloudflare D1, with a paced
  backfill script, to keep backtests and charts inside Workers Free limits.
- **Telegram:** each new live alert goes through an in-process event bus and a durable
  SQLite outbox to one chat or channel, linking to the site's Live view with that alert
  open. See [notifications task](tasks/backend-telegram-notifications.md).
- **Alert analysis** (opt-in `ANALYSIS_ENABLED`): relative-strength score vs SPY and the
  sector benchmark, the user's `technical-scan` script, and Claude agents for sentiment
  and news. Delivered as one short follow-up comment under the alert; full detail and
  charts on the site. See [alert analysis](features/alert-analysis.md) and its
  [task](tasks/backend-alert-analysis.md).

## Verification

`npm run check` passed on each merged PR (latest recorded: 117 tests, 1 opt-in skipped).
In production: Telegram test and synthetic alerts reached the phone, and a stored SMCI
alert was re-analyzed end to end in 32 s. Not yet verified: a real live alert flowing
through Telegram with analysis without manual re-run; Telegram topics/channel comments
with the real bot; the analysis panel's appearance on a phone; Claude cost and latency
per alert; real 40-symbol backtest run time; IEX vs SIP volume accuracy for the live
signal. Railway auto-deploy from `main` was not running as of PR #24; deploys were manual.

## Next

1. Watch the next live alerts end to end (alert → Telegram → analysis comment → site link).
2. Measure Claude cost/latency per alert and tune effort and web-search limits.
3. Decide on live SIP versus IEX for the production signal (volume floor revisit).
4. Fix or confirm Railway auto-deploy from `main`.
5. Options open interest for the technical analysis, if wanted.

## Conventions

TypeScript, React and Node; AGENTS.md is canonical. Any session that changes the app
updates this file in the same PR (see [roles](roles/index.md#shared-agreement)).
Only task-planner and reviewer agents are authorized; neither is implemented.
