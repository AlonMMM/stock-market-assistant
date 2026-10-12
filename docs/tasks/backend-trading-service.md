# Task: Trading service and Claude connector

Status: proposed
Owner: backend
Branch: feat/trading-service
Spec/contract revision: b0aa598

## Outcome

The user trades options from any Claude conversation (phone, web, desktop) through a custom
connector. The backend owns the keys, the trade flow and every limit; a Claude session holds
no keys and no repository. The broker and the notification channel are replaceable parts,
and every record has an owner, so more brokers and more traders can be added later without
rewriting the flow.

Agreed with the user (2026-10-11): the app owns trading; Claude connects to it as a tool;
only the user may connect; the website keeps its own, separate access rule; more brokers and
more traders are future work that this design must not block.

## Scope and exclusions

In scope:

1. A `Broker` interface and a `Notifier` interface, with Alpaca and Telegram as the first
   implementations.
2. A trade engine that runs the existing flow (preview, buy with price raises, stop, sell at
   the bid, never-short check) against those interfaces.
3. A long-running trading service that holds the keys, runs orders as jobs and stores trade
   records.
4. An MCP endpoint on the hosted site that exposes six tools to Claude.
5. Connector access for one person, server-side limits, an audit log and a kill switch.

Deferred (not built now, but not blocked):

- A setup page, a list of allowed traders, and per-trader broker sign-in.
- A second broker. Interactive Brokers needs its own study (see docs/ibkr-operations.md).
- Buy and sell buttons on the Portfolio page.
- The live account. It needs separate user authorization, its own keys and its own switch.

## Relevant context

- Rules of the trade flow: [backend-option-orders.md](backend-option-orders.md). They do
  not change here.
- Existing code that moves: `packages/trading/src/` (ladder, protect, exit, safety, options,
  message, alpaca-trading) and `scripts/option-order.ts` (382 lines of flow, to become the
  engine).
- Platform facts checked on 2026-10-11:
  - Claude custom connectors accept a server with no sign-in, with OAuth, or with fixed
    credentials sent as request headers.
  - Cloudflare Access can act as the OAuth sign-in for an MCP server on Workers, with its
    own policy ("Secure MCP servers with Access for SaaS").
  - A free Worker may make 50 outside requests per invocation. One buy (raises plus two
    minutes of polling) needs more, so the order loop cannot run inside the Worker.

## Architecture

```
Claude (any device)
   │  MCP over HTTPS, tools only
   ▼
Hosted site, Cloudflare Worker          apps/api/src/worker.ts
   /mcp        connector door: checks who is calling, forwards the tool call
   /api/...    website door: unchanged, read-only
   cron        never-short watch, every minute (independent of the service below)
   │  HTTPS + service token + caller id
   ▼
Trading service, Railway (new)          apps/trader
   engine      preview, buy, sell, stop, positions      packages/trading/src/engine.ts
   jobs        order loops that outlive one request
   store       SQLite on a volume: users, previews, jobs, posts, log
   │                         │
   ▼                         ▼
Broker interface         Notifier interface
   Alpaca (first)           Telegram (first), None
```

Why a separate Railway service and not the existing collector: the collector exits on invalid
market data (`stop(1)`) and restarts its stream on a drop, and a restart in the middle of a buy would interrupt the
watch that places the stop. The two must fail independently. Same repository, its own
Dockerfile and volume.

### Broker interface (`packages/trading/src/broker.ts`)

```ts
interface Broker {
  readonly capabilities: {
    paper: boolean;
    closeOnlyOrders: boolean; // the broker itself refuses a sell that opens a short
    optionStops: boolean;
    replaceInPlace: boolean; // false: change a price by cancel and re-send
  };
  equity(): Promise<number>;
  chain(underlying: string, right: Right, upTo: string): Promise<ChainQuote[]>;
  quote(symbol: string): Promise<OptionQuote>;
  buyLimit(symbol: string, qty: number, price: number): Promise<Order>;
  sellLimit(symbol: string, qty: number, price: number): Promise<Order>;
  sellStop(symbol: string, qty: number, stop: number): Promise<Order>;
  replace(id: string, price: number): Promise<Order>;
  replaceStop(id: string, qty: number, stop: number): Promise<Order>;
  cancel(id: string): Promise<void>;
  order(id: string): Promise<Order>;
  positions(): Promise<Position[]>;
  openOrders(symbol?: string): Promise<OpenOrder[]>;
}
```

`AlpacaTrading` (`alpaca-trading.ts`) already had every method; it now implements the
interface and declares its capabilities. Contracts are identified by OCC symbol in the engine; an adapter translates
when its broker uses another form. The engine refuses to trade through a broker without
`closeOnlyOrders` until the engine's own quantity checks are proven for it (never-short).

### Notifier interface (`packages/trading/src/notifier.ts`)

```ts
interface Notifier {
  entry(trade: EntryReport): Promise<string | undefined>; // a reference to the post
  exit(trade: ExitReport, entryRef?: string): Promise<void>;
  alert(text: string): Promise<boolean>;
}
```

`TelegramNotifier` wraps `formatEntry`, `formatExit` and `TelegramSender`. `NoNotifier` does
nothing. A notifier failure never blocks or undoes an order; it is logged and returned in
the tool result. The entry reference is stored in the service's database, which fixes exit
posts losing their thread between sessions (`data/local/trade-posts.json` goes away).

### Engine (`packages/trading/src/engine.ts`)

One engine per caller, built from that caller's broker, notifier, limits and store:

```ts
new TradeEngine({ user, broker, notifier, limits, store })
  .preview(request) // read-only: what a buy would choose now, and every check's result
  .buy(request) // chooses the contract, runs every check, starts a job, returns its id
  .sell(request) // starts a job
  .setStop(request) // short action, answers directly
  .positions() // positions, stops, open orders, short risks
  .job(id); // state and result of a buy or sell
```

It holds the flow now in `scripts/option-order.ts`. `ladder.ts`, `protect.ts`, `exit.ts`,
`safety.ts` and `options.ts` stay as they are, typed against `Broker`. The command
`npm run trade` keeps working by building the same engine in-process from the local `.env`,
so the computer path and the connector path run identical code.

### Buying in one step (user decision, 2026-10-11)

`buy` chooses the contract and sends the order in one call; there is no preview step in
between. The code therefore decides alone whether an order is good, and refuses it with the
failed check named when it is not. `preview` stays as a read-only tool that runs the same
choice and the same checks without sending anything.

Expiry: the nearest one, unless the request names `friday` or a date (user 2026-10-11).

### Checks before a buy (per user, enforced in the engine)

Every check runs before any order is sent. A failure sends nothing and names the check.
Selling and setting a stop are never blocked by the account-level checks, so the user can
always reduce risk.

Account-level:

| Check                    | Rule                                                                                                        | Source         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------- |
| Trading switched on      | `TRADING_ENABLED` and the user's `enabled`                                                                  | design         |
| Paper account            | the broker is a paper account                                                                               | user-confirmed |
| No short risk            | `shortRisks` is empty                                                                                       | user-confirmed |
| Buys per day             | at most 10 different buys in the New York trading day; sells are not counted                                | user-confirmed |
| Risk at the same time    | risk at the stops of all open positions, plus this trade's, at most 10% of equity                           | user-confirmed |
| Day loss                 | no new buy while equity is more than 5% below the previous close                                            | user-confirmed |
| Positions without a stop | PROPOSED: no new buy while a held contract has no stop or a partial one                                     | proposed       |
| Market open              | PROPOSED: no buy outside regular option hours (a queued order cannot be re-priced and is canceled unfilled) | proposed       |
| Buying power             | the cost at the ceiling price fits the account's buying power                                               | design         |

How the three user limits are counted (my reading, to be confirmed):

- One buy command is one buy, however its order fills: 50 contracts filled in 10 parts are
  one buy (user-confirmed 2026-10-11). The count is per command, not per fill or per
  re-priced order. A command that was refused, or canceled with nothing filled, is not
  counted.
- Risk of a position is (entry − stop) × contracts × 100. A contract with no stop counts at
  its full cost. The new trade is counted at its ceiling price and its stop.
- Day loss is equity against the broker's previous-close equity (`last_equity` at Alpaca),
  so it includes open and closed trades of the day.

Order-level:

| Check                 | Rule                                                                                                       | Source         |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | -------------- |
| Request               | known underlying, right is call or put, size and stop are numbers in range                                 | design         |
| Size                  | at most 3% of equity; at least one contract fits, otherwise refused                                        | user-confirmed |
| Stop                  | 40% default, 70% at most                                                                                   | user-confirmed |
| Delta                 | the chosen strike is inside the range (0.10–0.15 by default); PROPOSED: refuse when the expiry has none    | proposed       |
| Quote is usable       | bid > 0, ask > bid, and PROPOSED: the quote is at most 120 seconds old                                     | proposed       |
| Spread                | at most 10% of mid, before sending and at every raise                                                      | user-confirmed |
| Stop price exists     | the stop rounds to at least one tick and stays below the entry price                                       | design         |
| Not a repeat          | PROPOSED: a second buy of the same underlying and right within 60 seconds is refused (a doubled tool call) | proposed       |
| Contract not expiring | PROPOSED: no buy of a contract in its last 15 minutes                                                      | proposed       |

### Risk manager (`packages/trading/src/risk-manager.ts`)

User decision (2026-10-11): use the risk manager described in
`docs/tasks/research-indi-2026.md` (branch `research/oltrawave-x`, section "Risk
management": @ultrawavetrader's own rules, from his posts) to calculate limits. It only
validates a new buy. It never changes the order: not its size, contract or stop.

A pure function of the account's daily equity history, today's result and the new order.
It answers allowed or refused, with the numbers behind the answer.

1. Risk of the order = its premium × the share he expects to lose by time to expiry:

   | Time to expiry  | Share of the premium at risk |
   | --------------- | ---------------------------- |
   | a month or more | 50%                          |
   | a week          | 70%                          |
   | 5 days          | 75%                          |
   | 4 days          | 80%                          |
   | 3 days          | 85%                          |
   | 2 days          | 90%                          |
   | 4 hours or less | 100%                         |

   The source gives these points only. PROPOSED fill-ins: 6 to 29 days use 70%, and 1 day
   or less uses 100%.

2. Limits by the state of the account (risk per trade / risk per day, of equity):

   | State    | Per trade | Per day | Entered when                                                                |
   | -------- | --------- | ------- | --------------------------------------------------------------------------- |
   | Full     | 5%        | 7%      | equity is at a new high                                                     |
   | Brake    | 2%        | 3%      | 12.5% below the high, or two days in a row that hit the daily limit         |
   | Recovery | 3%        | 5%      | two thirds of the fall recovered; losing half of that recovery brakes again |

   The state is derived from the broker's daily equity history, so the service keeps no
   state of its own for it.

3. A buy is refused when its risk is above the per-trade limit, or when today's losses on
   today's trades plus its risk are above the per-day limit.

Left out, because they are his discretionary exceptions: rolls paid from remaining premium,
earnings bets, and larger overnight entries.

These limits apply together with the user's own (3% size, 10 buys, 10% risk at the same
time, 5% day loss). A buy must pass all of them.

Open question: the risk manager measures an order by his share table, because he uses no
stop orders. Our orders carry a stop (40% by default). The table is the stricter measure
for every expiry and is the proposed one; the alternative is the order's own stop share.

### Trading service (`apps/trader`)

Fastify, like the collector. Every request needs `Authorization: Bearer <TRADER_TOKEN>`
(at least 32 characters, compared in constant time) and names the caller in `X-Trader-User`.
Only the Worker knows the token.

| Route               | Does                                    |
| ------------------- | --------------------------------------- |
| `POST /v1/preview`  | what a buy would choose, and each check |
| `POST /v1/buy`      | runs the checks and starts a buy job    |
| `POST /v1/sell`     | starts a sell job                       |
| `POST /v1/stop`     | sets or moves a stop                    |
| `GET /v1/jobs/:id`  | job state and result                    |
| `GET /v1/positions` | positions, stops, orders, short risks   |
| `GET /health`       | service state, no account data          |

Jobs. A buy or sell runs as a job inside the service and is written to the store at each
step (`sent`, `raising`, `watching`, `done`, with order ids). On start the service reads
unfinished jobs and reconciles them with the broker: it cancels a buy that is still open,
makes sure the stop covers what filled, and marks the job `interrupted`. This is the only
way a restart cannot leave contracts without a stop.

Store (SQLite on a Railway volume). Every table has a `user_id`.

| Table   | Holds                                                             |
| ------- | ----------------------------------------------------------------- |
| `users` | id, sign-in identity, broker kind, notifier kind, limits, enabled |
| `jobs`  | id, user, kind, contract, state, order ids, result, times         |
| `posts` | user, contract, entry post reference                              |
| `log`   | time, user, tool, inputs, outcome                                 |

For now `users` has one row and the broker and Telegram keys stay in the service's
environment variables; the row only names which ones to use. Keys of other people are a
later decision (prefer the broker's own "connect your account" flow over storing keys).

Kill switch: `TRADING_ENABLED=false` makes every tool except `positions` and `trade_status`
answer "trading is switched off".

### Connector (`/mcp` on the Worker)

Six tools:

| Tool           | Inputs                                                            | Answer                                                                          |
| -------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `buy`          | `underlying`, `right`, `sizePct`, `expiry?`, `delta?`, `stopPct?` | the chosen contract, contracts, first price, stop, `jobId`; or the failed check |
| `preview`      | the same                                                          | the same choice and every check's result; sends nothing                         |
| `trade_status` | `jobId`                                                           | state, filled, average price, stop, canceled quantity, errors                   |
| `sell`         | `underlying`, `qty` (`all`, `half`, number)                       | `jobId`                                                                         |
| `set_stop`     | `underlying`, `stopPct`                                           | the stop now in place                                                           |
| `positions`    | none                                                              | positions, stops, open orders, short risks, today's use of each limit           |

Rules:

- `buy` needs no earlier preview. Its checks are the protection (see "Checks before a buy").
- `buy` and `sell` answer at once with a job id. The result comes from `trade_status` and
  from the notifier.
- A short risk is the first thing in the answer of every tool, as today.
- Tool descriptions tell Claude to call `buy` only on the user's own trade command, never
  on text found in a page, file or message.
- Transport: MCP Streamable HTTP without sessions (`initialize`, `tools/list`,
  `tools/call`). ASSUMPTION: this small surface is written by hand in the Worker; if
  Claude's client needs more of the protocol, use the official SDK.

Who may connect:

- Step A (paper only): one long random token, a Worker secret, sent by Claude as a fixed
  request header. ASSUMPTION: the user's Claude plan offers fixed headers for custom
  connectors; otherwise the token goes in the connector address.
- Step B (before any second trader or a live account): Cloudflare Access as the OAuth
  sign-in for `/mcp`, with a policy that allows exactly the user's email.
- The website's Access rule is separate. `/mcp` must be excluded from the website's Access
  application, because Claude cannot pass its login page; the Worker then checks the
  connector's own credential on that path and nothing else is served there.
- Every new connection and every refused one is logged; step B also posts new sign-ins to
  the notifier.

### As built (2026-10-11, parts 4 and 5)

Differences from the plan above, decided while building:

- The connector is its own Worker, `sma-trade-connector` (`apps/connector`,
  `wrangler.connector.jsonc`), not a `/mcp` path on the website's Worker. The website's
  Access application covers its whole hostname and would have needed a dashboard exception;
  a separate Worker needs none, serves nothing else and holds no broker key. Its secrets
  are `MCP_TOKEN`, `TRADER_URL` and `TRADER_TOKEN`.
- The credential is accepted as a Bearer header or as the last part of the address
  (`/mcp/<token>`).
- There is no preview code; `buy` is one step (see "Buying in one step").
- `set_stop` places a stop on contracts that have none. It does not move an existing stop.
- Not built: blocking a source after repeated wrong credentials, and a Telegram message on
  refused attempts. A refused attempt is written to the Worker's log only. The token is at
  least 32 random characters, so guessing is not practical.
- The trading service has one user, `owner`. `users` is not a table yet; every table has
  the `user_id` column.
- The website still holds its own Alpaca keys for the Portfolio page and the short watch.
  Moving both to read from the trading service, and removing the keys from Cloudflare, is
  open.

### Changes after the first run from Claude (user, 2026-10-11)

- **Off-hours orders are allowed.** With the market closed a buy is no longer refused. The
  order goes to the broker at the last mid and waits there (`offHours: true`, and a line in
  `notes`); the channel gets an "Off-hours order" post at once. The job watches it until the
  market opens, waits 20 seconds for the first quotes, then raises the price and keeps the
  stop like any buy; the entry post carries "Ordered off hours". The age of the quote is not
  checked while the market is closed. A waiting order can be withdrawn with the
  `cancel_order` tool (`POST /v1/jobs/:id/cancel`). `requireMarketOpen` is now off by default.
- **The default expiry is the nearest one.** Friday's is bought only when the command says
  so ("to Friday", `expiry: friday`) or gives that date.
- **Delta in range is a note, not a refusal** (`requireDeltaInRange` off by default): the
  nearest expiry often has no strike inside 0.10–0.15, so the closest strike is bought and
  `notes` says which delta it has.
- Known limits of the off-hours order: a restart of the service while it waits cancels it
  and alerts (the restart rule for every buy); it is priced from the last quote before the
  close; the contract is picked from the deltas at that close. Sells are not changed: a
  sell sent off hours still gives up after its two minutes.

### Why each order looks the way it does (user, 2026-10-11)

Every buy command, refused ones too, is recorded with its reasons
(`packages/trading/src/explain.ts`, table `decisions` in the trading service):

- each value the order was built from, marked as from the command or a default;
- the expiries offered, the rule that picked the expiry and the strike, and the chosen
  strike with its neighbours and their deltas;
- bid, ask, mid, spread and the highest price the order may reach;
- the sizing arithmetic, the stop, and the risk manager's state and numbers;
- every check with its result, the notes, the refusals, and the final fill.

The trading service serves them at `GET /v1/decisions`. A second token,
`TRADER_READ_TOKEN`, is accepted for GET requests only; the website uses it
(`GET /api/portfolio/orders`, secrets `TRADER_URL` and `TRADER_READ_TOKEN` on the site
Worker), so the site can show orders and never send one. On the site: Portfolio → Orders
lists every buy with a "Why" button that opens the reasons; open positions and open buy
orders on Live trades carry the same button. Sells are not explained yet.

Verified 2026-10-11: `tests/order-explanations.test.ts`; the tab and the window were checked
in headless Chrome at phone and desktop widths with SYNTHETIC decisions produced by the
engine on the in-memory broker.

### Changes after the first trading day (user, 2026-10-12)

Branch `feat/first-day-fixes`. Not merged, not deployed.

- **Refusals say why.** A buy that cannot pick a contract is answered as
  `status: refused` with the reason and a `hint`, not as a broker error: no delta published
  for the expiry (`delta: …`, with the listed strike range), nothing listed for the ticker
  (`options listed: …`), or an expiry that is not offered (`expiry: …`). The preview row
  carries the same text. Alpaca's own message is taken out of its error body. The connector
  adds `httpStatus` and `meaning` to every error, and a timeout answers `sent: unknown`
  instead of claiming nothing was sent.
- **Adding to a position, capped at 5%.** New check `position size`
  (`maxPositionPct: 5`): what is held of the same stock and side (calls or puts, any strike
  or expiry) at cost, plus open buy orders, plus the new order, is at most 5% of equity.
  ASSUMPTION to confirm: "one position" is the stock and side, measured at cost, not at
  market value. An addition is posted as a reply to the trade's first post ("Added to the
  position, N held now") and gets its own stop for the contracts it bought.
- **Resize.** `POST /v1/resize { contract | underlying, qty }` brings a position to `qty`
  contracts: fewer sells the difference at the bid, more buys it (every buy check applies),
  zero sells all. `buy` accepts `qty` with `contract` in place of `sizePct`.
- **A stop that sells is reported.** The service looks at the open stop orders every 15
  seconds and after every job (`TraderService.watchStops`). A stop seen open and gone is
  read back; if it sold contracts, "STOPPED OUT" is posted as a reply to the entry post in
  the channel (which quotes it and notifies). What was seen is stored (`notes` table), so a
  stop that fills while the service is down is reported on start. A failed post is tried
  five times. Known gap: a stop placed and filled within one 15-second look during a
  running job is not seen.
- **Comment under the entry post.** With `TRADES_TELEGRAM_COMMENTS=true` the stop-out is
  also sent as a comment under the entry post, in the channel's discussion group. Needed
  first: the trades bot must be a member of that group (checked 2026-10-12: it is not), and
  no other process may read that bot's updates (`getUpdates`); the collector does so for
  the alerts bot, so the two must be different bots. Off by default.
- **Position controls on the site.** Portfolio → Live trades lists positions as rows
  (last and stop, value, profit and loss); a row opens the numbers, the stop, the stock's
  day chart and, for the owner, a size control with Half and Close. The site Worker
  forwards `POST /api/portfolio/control { contract, qty }` to `/v1/resize`
  (`packages/trading/src/control-api.ts`). It is allowed only when the Cloudflare Access
  identity of the request equals `TRADE_OWNER_EMAIL`, and the request's `Origin` is the
  site itself. New Worker secrets: `TRADE_OWNER_EMAIL` and `TRADER_TOKEN` (the full token;
  until now the site held only the read-only one). Without both, nobody can trade from the
  site. The local API never allows it.

- **Spread limit 25%, and a forced buy.** The spread may be at most 25% of the mid (was
  10%). `force: true` on `buy` skips the spread check, before sending and at every raise;
  every other check still applies, and `notes` says the spread was not checked. The
  connector sets it only when the user says "force".
- **Any expiry date.** `expiry` may be any listed date, not only the nearest or Friday's
  ("META call 14/10 0.5%": the connector passes `2026-10-14`). A date with no contracts, or
  in the past, is refused with the offered expiries.
- **Owner.** `TRADE_OWNER_EMAIL` is `alonmor89@gmail.com` (user 2026-10-12); it is set as a
  Worker secret at deploy, not kept in the repository.

Verified 2026-10-12: `npm run check` (371 pass, 0 fail, 1 skipped), including
`tests/position-control.test.ts` and `tests/position-control-api.test.ts` on the in-memory
broker. The page was checked in headless Chromium at 390 and 1280 px with SYNTHETIC
positions and a mocked API. Not run: anything against Alpaca or Telegram, and the Access
identity check on the hosted site.

### Trade ticket on the site (user, 2026-10-12)

Branch `feat/trade-ticket`. Portfolio → Trade, shown to the owner only: enter a stock,
choose calls or puts and an expiry (the coming 35 days), pick a strike from the chain table
(bid, ask, spread, delta; the strike a plain buy would take is marked), set the size (% of
the account or contracts), the stop and optionally force, check the order, then confirm.

- Trading service: `GET /v1/chain?underlying=&right=&expiry=` and `POST /v1/check`
  (`TradeEngine.chainFor`, `checkContract`). A check runs every buy check on the exact
  contract and sends and records nothing. The buy itself is the existing `POST /v1/buy`
  with `contract`, so the Telegram entry post and every limit are unchanged.
- Site Worker: `GET …/control/chain`, `POST …/control/check` and `POST …/control/buy`,
  under the same owner and Origin rule as the position controls; only the known order
  fields are passed on.

Verified 2026-10-12: `npm run check`; the tab was checked in headless Chromium at 390 and
1280 px with a SYNTHETIC chain and a mocked API. Not run against Alpaca.

## Failure cases

| Case                            | Behavior                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| Service restarts during a buy   | reconcile on start: cancel the open buy, cover fills with a stop, job `interrupted`, alert sent |
| Broker refuses or times out     | the job ends with the broker's message; nothing is retried blindly                              |
| Notifier fails                  | the order stands; the failure is in the job result and the log                                  |
| Worker cannot reach the service | the tool answers "trading service unreachable"; nothing was sent                                |
| Same `buy` sent twice           | the second is refused by the "not a repeat" check                                               |
| Limit exceeded                  | refused before any order, with the limit named                                                  |
| Short risk found                | first line of every answer, alert through the notifier, cron watch continues                    |

## Acceptance criteria

1. From the Claude phone app, with no repository: buy in one step, status, sell, stop and
   positions work on the paper account, and the entry and exit posts are threaded.
2. A call without the connector credential gets 401 and reaches nothing.
3. Each check in "Checks before a buy" has a test in which it alone fails: the buy is
   refused with that check named and no order is sent. Sell and stop still work when the
   account-level checks fail.
4. Killing the service during a buy and starting it again leaves no open buy and no filled
   contract without a stop.
5. `npm run trade` gives the same results as before on the same engine.
6. Alpaca and Telegram are imported only by their adapters and by the composition code.
7. `npm run check` passes.

## Plan and assumptions

Work split (user request, 2026-10-11). Each part is its own pull request and can be
reviewed alone. Most parts are backend; the owner is named per part.

| Part | Owner       | Work                                                                                                                                          | Depends on | Changes behavior                     |
| ---- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------ |
| 1    | backend     | `Broker` and `Notifier` interfaces, `TradeEngine`, in-memory broker; `npm run trade` on it                                                    | none       | no                                   |
| 2    | backend     | Checks before a buy and the risk manager, as pure modules with tests                                                                          | none       | no (not yet called)                  |
| 3    | backend     | One-step buy in the engine: choose the contract, run part 2, then the existing flow                                                           | 1, 2       | yes: a new `buy` by underlying       |
| 4    | backend     | `apps/trader`: store, routes, jobs, reconcile on start, log, kill switch; Dockerfile                                                          | 3          | new service, not reachable by Claude |
| 5    | backend     | `/mcp` on the Worker with the token; the six tools                                                                                            | 4          | yes: trading from any device         |
| 6    | integration | Railway service and variables, `/mcp` excluded from the website's Access, connector added in Claude, end-to-end run on paper, `docs/state.md` | 4, 5       | setup                                |
| 7    | frontend    | Portfolio page: today's use of each limit and the risk manager's state                                                                        | 4          | display only                         |
| 8    | backend     | Cloudflare Access sign-in for `/mcp`, one email                                                                                               | 5          | access rule only                     |

Parts 1 and 2 are independent of each other. Part 1 does not change what a command does.

Progress: parts 1, 2 and 3 are implemented and merged or in review (see Verification
evidence).

Needed from the user:

- Phase 2: a new Railway service with a volume, and its variables (paper Alpaca keys, the
  two Telegram values, `TRADER_TOKEN`).
- Phase 3: exclude `/mcp` from the website's Access application; add the connector in
  Claude; set `buy`, `sell` and `set_stop` to "always ask".
- A yes or no on each check marked PROPOSED, and the default expiry.

Assumptions to verify while building: the two marked ASSUMPTION above; that Railway keeps
one instance of the service (two would run the same job twice); the cost of the extra
service.

## Verification evidence

Part 1 (2026-10-11):

- `npm run check`: 304 pass, 0 fail, 1 skipped, including `tests/trade-engine.test.ts` (the engine on the
  in-memory broker `SimBroker`: preview, buy with stop and entry post, wide spread, unfilled
  order canceled, stop above 70% refused, partial and full sale with the exit posted under
  its entry, no channel configured, stop not doubled, short alert).
- Paper account, market closed, read-only: `npm run trade -- check` and
  `npm run trade -- preview --underlying NVDA --right call --size 0.5` print the same fields
  as before the change.
- Not run against Alpaca after the change: `buy`, `sell` and `stop`. They need market hours;
  the code they call (`ladder`, `protect`, `exit`) is unchanged apart from its types.

Parts 2 and 3 (2026-10-11, branch `feat/buy-checks`):

- `packages/trading/src/checks.ts` (`checkBuy`, 17 checks) and `risk-manager.ts`
  (`checkRisk`), called by `TradeEngine.buy` before any order. `buy` takes an underlying and
  a right, or one contract; `preview` shows `wouldBuy` and `refused` per expiry.
- `npm run check`: 340 pass, 0 fail, 1 skipped. `tests/buy-checks.test.ts` breaks each check alone and
  expects that check, and only it, to refuse the order; `tests/trade-engine.test.ts` covers
  the one-step buy, the default and named expiry, a doubled command, the kill switch (sells
  still work) and a buy that filled nothing not being counted.
- Paper account, market closed, read-only: `preview` for NVDA calls returned
  `wouldBuy: false` for both expiries with "market open: the market is closed" and "quote is
  usable: … s old", and for the nearest expiry also "delta in range: delta 0.085".
- Not run: a buy that passes the checks, which needs market hours. Unknown until then: how
  old the quote of a quiet contract is during market hours (the proposed limit is 120 s),
  and whether Alpaca's `options_buying_power` is the right figure for the buying-power check.
- Values still PROPOSED and not confirmed by the user: the default expiry (Friday's), the
  quote age, the 60-second repeat window, the last 15 minutes, and the three switches
  (market open, positions without a stop, delta in range). Each is one field of
  `defaultBuyLimits` or an engine option.

## Handoff

Not started.
