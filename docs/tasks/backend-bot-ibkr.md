# Task: the bot trades the owner's IBKR paper account

Status: implemented, deploy pending
Owner: backend
Branch: feat/bot-ibkr
Spec/contract revision: user request 2026-10-24 ("I would like to connect the bot with my
interactive brokers"); docs/features/multi-user-ibkr.md phase 3 (`IbkrTrading`, the owner's
IBKR paper account behind the Gateway)

## Outcome

With `BOT_BROKER=ibkr` on the trading service, the Indi bot buys and sells on the owner's IBKR
paper account (`owner-ibkr`, the account `IBKR_GATEWAY` adds; `apps/trader/src/seed.ts`)
instead of its Alpaca account. Everything else is unchanged: the signal and exits, the
owner's validator and risk manager, the Telegram posts marked 🤖 Bot, the stop watch and the
never-short check, and the market data (the owner's Alpaca SIP keys).

## Scope and exclusions

- `apps/trader/src/seed-bot.ts`: `chooseBotAccount(store, env)` reads `BOT_BROKER`
  (`alpaca`, the default, or `ibkr`). `ibkr` is the owner's enabled IBKR account; `alpaca`
  is the bot's own Alpaca account when added (`BOT_ALPACA_API_KEY` / `…_SECRET`), else the
  owner's default account, as before. A value that is neither, or `ibkr` without the IBKR
  account, throws and stops the service start, so a typo never trades another account.
- `apps/trader/src/main.ts`: the bot's trader is `Traders.forAccount(<chosen account>)`;
  the start log names it (`the bot trades the owner's IBKR paper account "owner-ibkr"
(BOT_BROKER=ibkr)`). When the chosen account cannot be built (no Gateway, missing keys)
  the bot is off and `/v1/bot` answers 409 with that reason.
- `GET /v1/bot` (`BotView`) adds `account: { broker, id }`, so the site can say where the
  bot trades. Optional in the type; no page uses it yet.
- **Equity history for the risk manager** (user 2026-10-24: "i must have the risk manager").
  TWS has no daily account history, so the service keeps it: `apps/trader/src/equity-log.ts`
  writes the account's value every minute of a trading day from the open, under the New
  York date, into `equity_days` (`TradeStore.recordEquity` / `equityDays`); the day's last
  write is the close. `IbkrTrading` reads that series through its `history` option, so the
  drawdown brake (12.5% off the high → brake limits) and the days-in-a-row rule work on
  IBKR as on Alpaca. A broker says it needs this with `capabilities.ownEquityHistory: false`
  (IBKR only). The series starts the day the account is connected: no past, so no drawdown
  until the account actually falls from a recorded high.
- Not changed: the Portfolio **Bot trades** tab still reads the Alpaca bot account through
  the Worker (`/api/portfolio/bot`, `docs/tasks/backend-bot-account.md`). With
  `BOT_BROKER=ibkr` it shows that Alpaca account, not the IBKR one. The Worker cannot reach
  the Gateway (private network); the tab would have to read the trader's `/v1/positions`
  with `X-Trader-Broker: ibkr` instead. Frontend/Integration decision, see "Next".
- Not changed: the bot's market data (Alpaca), the Gateway (`Dockerfile.gateway`,
  `deploy/gateway/start.sh`), `IbkrTrading`.

## Switches

| Setting                       | Where      | Effect                                                            |
| ----------------------------- | ---------- | ----------------------------------------------------------------- |
| `BOT_BROKER=ibkr`             | trader env | The bot trades the owner's IBKR paper account (`owner-ibkr`)      |
| `BOT_BROKER=alpaca` or unset  | trader env | As before: the bot's own Alpaca account, else the owner's default |
| `BOT_BROKER=ibkr`, no account | at start   | The service does not start (`needs the owner's IBKR account`)     |
| Gateway down at start         | at start   | The bot is off (logged, 409 on `/v1/bot`); the rest runs          |
| `BOT_ENABLED`, `BOT_MODE`     | trader env | Unchanged: off and dry-run by default                             |

## What differs on IBKR (from `IbkrTrading`, docs/tasks/backend-ibkr-broker.md)

- IBKR does not refuse a sell that opens a short, so the broker's own close-only check and
  the trader's minute watch are the gate; the bot only ever sells contracts it bought.
- Equity history is the service's own record (above), from the first connected day; a day
  the service was down all session has no row. The daily loss limit and the overnight cap
  use `NetLiquidation` live.
- Real-time market data only (`reqMarketDataType(1)`): the paper username shares the
  owner's data subscriptions; while IBKR Mobile streams, the paper account may get no data,
  and a signal is then skipped as "no prices".
- Strikes within 30% of the spot only (30 per expiry); the bot picks delta 0.15, inside it.

## Acceptance criteria

- With `BOT_BROKER=ibkr` the trader logs the IBKR start line; every bot buy, sell and stop
  is an IBKR order under the records scope `owner/owner-ibkr`; the owner's Trade page,
  connector and Alpaca accounts are untouched.
- Without it nothing changes (log line, account, records as before).
- `BOT_BROKER=ib` (typo) stops the start with a clear message.

## Verification evidence

- `tests/traders.test.ts`, "bot account: BOT_BROKER picks the owner's IBKR account; else its
  own, else the default": the four cases above plus the two refusals. Trader, bot, settings
  and IBKR tests: 83 pass.
- `tests/equity-log.test.ts`: one row per account and day with the last write winning;
  recorded only for brokers without their own history, on trading days from the open, not
  on a failed or empty read; the IBKR broker built by `Traders` answers `equityHistory`
  from the record.
- `npm run typecheck` passes; `npm run check` see the PR.
- Not verified: a real bot order on the IBKR paper account through the Gateway (the
  Gateway is online on Railway, logged in to paper `DUR786216`, API 4002 bridged to 4001;
  the trader logs `ibkr: connected to the Gateway`). Option quotes and chains from the paper
  account, and `PreviousDayEquityWithLoanValue`, are still unverified (as in the IBKR
  broker task).

## Deploy and connect (after merge, from a clean `origin/main`)

1. Merge; deploy `sma-trader` from a clean `origin/main` checkout.
2. Railway, `sma-trader`: set `BOT_BROKER=ibkr` (the service restarts; the log then shows
   `the bot trades the owner's IBKR paper account "owner-ibkr" (BOT_BROKER=ibkr)`).
3. Watch the first session: the 🤖 Bot Telegram posts, the IBKR paper account in the IBKR
   app, and the trader log for `No price for` / `IBKR has no contract` lines.
4. To go back: remove `BOT_BROKER`.

## Next

- Bot trades tab on IBKR: read the trader's `/v1/positions` and decisions for the
  `owner/owner-ibkr` scope instead of the Alpaca keys (product + frontend).
- The equity record has no past: if the brake should know the account's earlier high, load
  the IBKR account's past closes once (PortfolioAnalyst through the Claude connector, by
  hand) into `equity_days`.
