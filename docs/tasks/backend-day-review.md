# End-of-day review (backend)

User, 2026-11-05: "a skill for end of trading day ... running every day at 23:05 ... run backtest (app) and compare
the trade in enter time, enter and exit, enter and exit money, etc. ... summarize if the bot was too optimistic or
too pessimistic, and save it all with analysis under analyse tab in the bot window in the app." Both bots; a cloud
routine; real prices are the verdict, paper shown beside them; the day's backtest uses the option data the trading
service records ("we are saving the data of the options").

## How it works

1. **Trader** (read-only routes): `GET /v1/bot/day?day=` (signals, positions entered that day with every fill and
   book, the settings and stocks now) and `GET /v1/strangle/day?day=` (alerts, trades with orders and books).
2. **Website** (`packages/market-data/src/day-review.ts`, `day-review-run.ts`, routes in `apps/api/src/worker.ts`):
   - `POST /api/day-reviews/<bot>/<date>/start {force?}`: the day's recorded books into `option_quotes` as source
     `recorded` (Main: each position's buy and sale books and every second held, `/v1/records/ticks`; Volume: the
     alert books of every 0.10–0.35-delta contract and the held trades' ticks; a sample read during minute m is that
     minute's book, the newest one wins), the Volume day's alerts and second books if the 16:20 step has not run,
     then one backtest job (owner `system:day-review`, off the Backtest page's list), `quoteSources: ["databento",
"recorded"]` (the Backtest page itself still reads Databento only).
   - The cron and every read compare a finished run: the account (`runAccount` / `volumeAccount`, the live size and
     limits), then each live trade paired with the backtest trade of the same stock, side and kind nearest in time
     (Main 30 min, Volume 15 min); one-sided trades say why (the backtest's skip or account refusal; the live
     signal's outcome).
   - Live real price = the mid of the fill book, else the decision book. Fees $0.62 a contract each way on both
     sides. `dollarsGap` = the backtest's return at the live cost − live real $. Verdict on closed matched trades:
     the summed gap over the money paid, beyond ±5 points = optimistic / pessimistic.
   - `GET /api/day-reviews?bot=` (the Analyse page), `GET /api/day-reviews/<bot>/<date>`,
     `PUT .../analysis {verdict, headline, markdown}` (owner). Table `bot_day_reviews` in D1.
3. **Connector**: `day_review_start`, `day_review_get`, `day_review_save`, through a service binding to the website
   with the `DAY_REVIEW_TOKEN` secret (the same on both Workers); the website accepts that token on
   `/api/day-reviews` only, as the owner.
4. **Skill** `.claude/skills/end-of-day/SKILL.md`, run by a scheduled cloud routine at 23:05 Israel time on
   weekdays, with the connector attached.
5. **App**: Trading → 🤖 Main bot → Analyse, 🎯 Volume bot → Analyse (`apps/web/src/DayReviews.tsx`).

## Limitations

- The settings and stock list are the ones at review time (the same evening); a change during the day is not
  replayed. The live records carry the version.
- A backtest contract other than the live one has no recorded books: the Main bot prices it on trade bars (marked an
  estimate); the Volume bot's sale needs a minute book, so such a trade comes back unfilled until Databento's books
  are uploaded (then `force` a redo).
- A trade held overnight is judged when the next day's run redoes the day before.

## Setup to go live

`DAY_REVIEW_TOKEN` on the website Worker and on the connector Worker; deploy the trader (Railway), the website and
the connector from `origin/main`; create the routine.

## Checks

`npm run check`: 856 pass, 0 fail (tests/day-review.test.ts, tests/connector.test.ts).
