# Task: Buy and sell stocks from the site

Status: completed (in review)
Owner: backend (with a minimal Trade-tab UI)
Branch: feat/stock-trading

## Outcome

The account owner can buy and sell shares from Portfolio → Trade → Shares,
next to options.

## Decisions (user, 2026-10-16)

- Website only; no connector (chat) commands for stocks.
- No size or risk validation on stock buys.
- No automatic stop.
- Limit order stepped from the mid toward the ask (buy) or bid (sell), with
  pre/after-hours allowed.
- Existing hard rule: never short. A sale is limited to the shares held,
  less shares already offered by open sells.

## What changed

- Broker: optional `stockQuote`, `stockLimit` (whole shares, `limit`, `day`,
  `extended_hours: true`) and `stockPositions`. Alpaca and the simulator
  implement them. Option `positions()` is unchanged (options only).
- `packages/trading/src/stock-orders.ts`: price steps (cent ticks; 1/100 cent
  below $1), shares for a dollar amount, sellable shares, sell quantity
  (`all` | `half` | n), and the order routine: mid, then 4 moves 3 s apart,
  never back; an unfilled remainder stays working for the day.
- Trader service: `GET /v1/stock/quote`, `POST /v1/stock/buy`
  `{ symbol, qty | amount }`, `POST /v1/stock/sell` `{ symbol, qty }` as jobs
  (`stock-buy`, `stock-sell`). One running order per symbol. After a restart,
  a stock job's working order is left in place and reported. Changing a
  working stock order's price has no size limit.
- Short checks now cover stocks: the job check after each order, and the
  per-minute watcher (`portfolio.shortRisks` uses all positions and orders).
- Site API: `GET …/control/stock/quote`, `POST …/control/stock/buy|sell`,
  owner only, same-origin POST only.
- Web: Trade tab Options | Shares switch; Shares shows bid/ask/last, held and
  free shares, working orders, a buy (shares or dollars) and a sell
  (number, half, all), each with Confirm. Stock orders in Orders open in
  Trade for cancel or price change.

## Verification evidence

- `npm run check`: format, typecheck, 418 tests, build.
- New tests: `tests/stock-orders.test.ts` (prices, sizes, buy/sell jobs on
  the simulator, refusals that would go short) and the site-API stock routes
  in `tests/position-control-api.test.ts`.
- Alpaca paper, read-only, 2026-10-16 03:08 New York: `stockQuote` for AAPL,
  NVDA, SIRI and `stockPositions` return the expected data. No order was
  placed: the order body follows Alpaca's documented fields but is not yet
  verified with a real paper order.

## Limitations

- Alpaca extended hours are 04:00–20:00 New York. An order sent overnight
  waits for 04:00.
- No Telegram entry post or decision record for stock trades yet.
- The UI is minimal; a Frontend pass may restyle it.
- Deploying needs both the trader service (Railway) and the website Worker.
