# Task: the bot trades the owner's IBKR paper account

Status: implemented, deploy pending
Owner: backend (the Bot settings page's Broker switch included, at the user's request)
Branch: feat/bot-ibkr
Spec/contract revision: user requests 2026-10-24 ("I would like to connect the bot with my
interactive brokers"; "i must have the risk manager"; "can i make it configurable in the bot
settings? to trade via ibkr or alpaka acount?"); docs/features/multi-user-ibkr.md phase 3
(`IbkrTrading`, the owner's IBKR paper account behind the Gateway)

## Outcome

The Indi bot can buy on the owner's IBKR paper account (`owner-ibkr`, the account
`IBKR_GATEWAY` adds; `apps/trader/src/seed.ts`) as well as on its Alpaca account. The owner
picks the broker for new entries on the Bot settings page (`broker`); `BOT_BROKER` on the
trading service is only the default until the owner saves. A position is sold where it was
bought. Everything else is unchanged: the signal and exits, the owner's validator and risk
manager, the Telegram posts marked 🤖 Bot, the stop watch and the never-short check, and the
market data (the owner's Alpaca SIP keys).

## Scope and exclusions

- `packages/trading/src/bot/settings.ts`: `broker: "alpaca" | "ibkr"` in `BotSettings`
  (default `alpaca`; validated by `parseSettings`; `botBrokers` lists both).
- `apps/trader/src/bot.ts`: every call to the trading service goes through
  `trading(position?)`: a position's own broker (recorded on it at entry,
  `BotPosition.broker`), else the setting's. Positions from before the setting have no
  broker and use the start-up default. `setSettings` refuses a broker that is not connected
  (`canTrade`). The account's equity for sizing, the daily loss limit and the drawdown pause
  is the chosen broker's; the overnight cap uses the position's.
- `apps/trader/src/seed-bot.ts`: `botBrokerFromEnv` reads `BOT_BROKER` (`alpaca`, the
  default, or `ibkr`; anything else stops the service start, so a typo never trades another
  account). `botAccountFor(store, broker)`: `ibkr` is the owner's enabled IBKR account;
  `alpaca` is the bot's own Alpaca account when added (`BOT_ALPACA_API_KEY` / `…_SECRET`),
  else the owner's default account, as before.
- `apps/trader/src/main.ts`: at start, each broker whose account builds (keys, Gateway) is
  "connected" and logged; the bot gets `trading(broker)` → `Traders.forAccount(...)`. When
  the start-up default broker is not connected the bot is off and `/v1/bot` answers 409 with
  the reason. `PUT /v1/bot/settings` answers 409 for a broker that is not connected.
- `GET /v1/bot` (`BotView`) adds `brokers`, the connected ones; the chosen one is
  `settings.broker`.
- **Equity history for the risk manager.** TWS has no daily account history, so the service
  keeps it: `apps/trader/src/equity-log.ts` writes the account's value every minute of a
  trading day from the open, under the New York date, into `equity_days`
  (`TradeStore.recordEquity` / `equityDays`); the day's last write is the close.
  `IbkrTrading` reads that series through its `history` option, so the drawdown brake
  (12.5% off the high → brake limits) and the days-in-a-row rule work on IBKR as on Alpaca.
  A broker says it needs this with `capabilities.ownEquityHistory: false` (IBKR only). The
  series starts the day the account is connected: no past, so no drawdown until the account
  actually falls from a recorded high.
- Site (`apps/web/src/BotSettings.tsx`): a Broker switch (Alpaca | Interactive Brokers) next
  to the mode switch, an unconnected broker greyed out. Reset to defaults keeps the broker.
  Not checked in a browser here; the model and page compile and the build passes.
- Not changed: the Portfolio **Bot trades** tab still reads the Alpaca bot account through
  the Worker (`/api/portfolio/bot`, `docs/tasks/backend-bot-account.md`). With IBKR chosen
  it shows that Alpaca account, not the IBKR one. The Worker cannot reach the Gateway
  (private network); the tab would have to read the trader's `/v1/positions` with
  `X-Trader-Broker: ibkr` instead. Frontend/Integration decision, see "Next".
- Not changed: the bot's market data (Alpaca), the Gateway (`Dockerfile.gateway`,
  `deploy/gateway/start.sh`), `IbkrTrading`'s order flow.

## Switches

| Setting                       | Where         | Effect                                                              |
| ----------------------------- | ------------- | ------------------------------------------------------------------- |
| `broker` (Bot settings page)  | saved setting | Where new entries are bought; open positions stay with their broker |
| `BOT_BROKER=ibkr`             | trader env    | The default broker until the owner saves one                        |
| `BOT_BROKER=alpaca` or unset  | trader env    | As before: the bot's own Alpaca account, else the owner's default   |
| `BOT_BROKER=ib` (a typo)      | at start      | The service does not start (`BOT_BROKER must be alpaca or ibkr`)    |
| Default broker's account down | at start      | The bot is off (logged, 409 on `/v1/bot`); the rest runs            |
| Other broker's account down   | at start      | That broker is not connected: greyed out, 409 when chosen           |
| `BOT_ENABLED`, `BOT_MODE`     | trader env    | Unchanged: off and dry-run by default                               |

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

- With `broker` = `ibkr` saved (or `BOT_BROKER=ibkr` and nothing saved) every new bot buy,
  its stop and its sales are IBKR orders under the records scope `owner/owner-ibkr`; the
  owner's Trade page, connector and Alpaca accounts are untouched.
- A position bought at Alpaca is sold at Alpaca after the owner switches to IBKR, and the
  other way round.
- Without a saved choice and without `BOT_BROKER` nothing changes (log line, account,
  records as before). `BOT_BROKER=ib` (typo) stops the start with a clear message.

## Verification evidence

- `tests/traders.test.ts`, "bot account: BOT_BROKER is the start-up default; each broker
  maps to the owner's account there". `tests/indi-bot.test.ts`, "broker setting: new entries
  go to the chosen broker; a position is sold where it was bought" (also: an unconnected
  broker cannot be chosen). `tests/bot-settings.test.ts`: `broker` parsed, older saved
  settings keep the base's broker.
- `tests/equity-log.test.ts`: one row per account and day with the last write winning;
  recorded only for brokers without their own history, on trading days from the open, not
  on a failed or empty read; the IBKR broker built by `Traders` answers `equityHistory`
  from the record.
- `npm run typecheck`, the whole test suite and the build: see the PR for the run.
- Not verified: a real bot order on the IBKR paper account through the Gateway (the
  Gateway is online on Railway, logged in to paper `DUR786216`, API 4002 bridged to 4001;
  the trader logs `ibkr: connected to the Gateway`). Option quotes and chains from the paper
  account, and `PreviousDayEquityWithLoanValue`, are still unverified (as in the IBKR
  broker task). The page's new switch was not opened in a browser.

## Deploy and connect (after merge, from a clean `origin/main`)

1. Merge; deploy `sma-trader` from a clean `origin/main` checkout.
2. The log shows `the bot can trade at alpaca ("owner-bot") and ibkr ("owner-ibkr")`. On the
   site, Portfolio → 🤖 Bot → Settings → Broker: Interactive Brokers, then Save. No
   environment change is needed (`BOT_BROKER` is only the default before a save).
3. Watch the first session: the 🤖 Bot Telegram posts, the IBKR paper account in the IBKR
   app, and the trader log for `No price for` / `IBKR has no contract` lines.
4. To go back: Broker: Alpaca on the same page. Open IBKR positions are still sold at IBKR.

## Next

- Bot trades tab on IBKR: read the trader's `/v1/positions` and decisions for the
  `owner/owner-ibkr` scope instead of the Alpaca keys (product + frontend).
- The equity record has no past: if the brake should know the account's earlier high, load
  the IBKR account's past closes once (PortfolioAnalyst through the Claude connector, by
  hand) into `equity_days`.
