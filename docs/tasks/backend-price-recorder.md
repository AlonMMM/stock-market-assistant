# Task: record the prices the bots act on

Status: implemented on `feat/price-recorder`; deploy the trading service to start collecting
Owner: backend
Branch: feat/price-recorder
Spec revision: user 2026-10-28 ("for the volume bot maybe we can also save the seconds before
crossing", "also need when we bought it exactly in what price", "go ahead and implement this").

## Outcome

The trading service writes down, in its own database (`TRADER_DB`), the prices the bots already
read, so the Review page can replay live trades at the second, on real books:

1. **`order_steps`**: every step of every order of every account, as the broker answered:
   `sent` (asked qty, limit), `raised` (a buy's new limit), `repriced` (a sale's), `stop-moved`,
   `cancel`, `fill` (contracts filled in this step and **this step's own price**, from the change of
   the average), `filled` (the last fill; `filledAt` = Alpaca's own time of the full fill),
   `canceled` / `expired` / `rejected` / `replaced`. Each step carries the contract's bid / ask when
   a quote was read within 15 s (the ladder and the sale read one before every price) and the chain
   it belongs to (`rootId`, the first order before price changes).
2. **`position_ticks`, `phase = held`**: every second of regular hours, each position the Main bot
   holds (status open) and each leg the Volume bot holds (open or closing): the stock's last trade,
   the contract's bid / ask.
3. **`position_ticks`, `phase = watch`**: every second from the Volume bot's alert to the side
   (the trade's watching phase): the stock's last trade; and every 5 seconds the bid / ask of the
   call and the put it would pick (`StrangleBot.watchLegs`: the setting's delta of the trade's expiry,
   without the price and volume checks, picked once a watch). Watches that never cross are kept too.

Rows older than 400 days are deleted once a day.

## Code

- `apps/trader/src/recorder-store.ts`: the tables, inserts, reads (`steps`, `ticks`), `prune`.
- `apps/trader/src/order-recorder.ts`: `recordingBroker`, a wrapper around each account's broker
  (`Traders` option `wrapBroker`, set in `main.ts`). Nothing about how orders are sent changes; an
  error writing a step is logged and the order goes on. An order first seen after a restart is
  noted without steps for its past fills (no duplicates).
- `apps/trader/src/price-recorder.ts`: `PriceRecorder`, ticked every second in `main.ts`; only in
  regular hours (09:30 to the core close, New York). Quotes come from Alpaca (the app's market
  data), also for a Main bot position held at IBKR, so the Gateway is not asked every second.
- `packages/trading/src/broker.ts`: `Order.filledAt` (Alpaca's `filled_at`).
- Trader routes, readable with the read-only token:
  `GET /v1/records/orders?from=<date or time>&to=…&contract=…` (default: one day from `from`) and
  `GET /v1/records/ticks?ref=<position or trade id>` or `?from=…&to=…`; at most 50,000 rows a read.

## Size and load

A position held a whole day is about 23,400 rows; a watch at most ~600. Two Alpaca calls a second per
held position (the stock price call is shared by all) and two option quotes every 5 seconds per watch:
well inside Algo Trader Plus's 10,000 a minute. A few MB a month.

## Verification

- `tests/recorder.test.ts`: a laddered buy through the wrapper (send, raise, a 20-contract fill with
  the raise, the next raise, the last 16 with Alpaca's fill time, the books); a sale re-priced to the
  bid; an order from before the start not recorded twice; the price ticks (a held position every
  second, a watch with legs picked once and quoted every 5 s, nothing after the close, prune).
- `npm run check` passes.
- Not verified: a real session (needs the deploy of the trading service on Railway).

## Not done

- The site has no route or page for these yet: the Review page (designed at
  https://claude.ai/artifact/LSMxNqsoDhSHcYQgraAqo3) will read them.
- IBKR orders have no `filledAt` (the Gateway's order status has no fill time); their steps carry the
  time the service saw them.
