# Task: Every stock order type a broker offers

Status: backend completed (in review); frontend not started
Owner: backend
Branch: feat/order-types

## Outcome

User request (2026-10-17): "in the trade options I can only buy stocks; there is no
limit/stop/market or other options, or sell. Give me all the options a real broker
gives." The Shares ticket only sends one stepped limit order. This adds a typed stock
order with every Alpaca equity order type, every time in force, extended hours, buy and
sell, a check that sends nothing, and changes to an open order.

The stepped "auto" buy and sell (`/v1/stock/buy|sell`) stay as they are.

## Rules

- Long only (hard rule): a sell may close only shares held and not already offered by
  another open sell (`all`, `half` or a number). Growing an open sell is held to the same
  limit. The short check runs after every order and every change.
- Per the user (2026-10-16), unchanged: no size or risk checks on stock buys, and no
  automatic stop.
- Alpaca's equity rules are checked before sending, so a refusal names the field:

| Type            | Prices                         | Time in force                |
| --------------- | ------------------------------ | ---------------------------- |
| `market`        | none                           | day, gtc, opg, cls, ioc, fok |
| `limit`         | `limitPrice`                   | day, gtc, opg, cls, ioc, fok |
| `stop`          | `stopPrice`                    | day, gtc                     |
| `stop_limit`    | `stopPrice`, `limitPrice`      | day, gtc                     |
| `trailing_stop` | `trailPercent` or `trailPrice` | day, gtc                     |

- `extendedHours: true` only for `limit` with `day` or `gtc` (Alpaca's rule).
- Prices are whole cents from $1 and 1/100 cent below $1; others are refused.
- `amount` (dollars, buys only) becomes whole shares at the order's own price: the limit,
  the stop for a stop buy, else the ask.
- Notes, which do not stop the order: a stop already reached (triggers at once), a limit
  that can fill at once, a stop limit whose limit is on the wrong side of its stop, the
  market being closed, and what ioc/fok mean.

## Contract (for Frontend)

Site (owner only, same-origin POST), forwarded to the trading service:

- `POST /api/portfolio/control/stock/check` and `…/stock/order`, body
  `{ symbol, side: "buy"|"sell", type, timeInForce?, qty | amount, limitPrice?,
stopPrice?, trailPercent? | trailPrice?, extendedHours? }` (sell `qty` may be `"all"`
  or `"half"`). Answer: `status` `"checked"` or `"sent"`, the normalized ticket
  (`symbol side qty type timeInForce` plus its price fields), `held`, `sellable`, `bid`,
  `ask`, `last`, `estimatedCost`, `notes[]`; when sent also `orderId`, `orderStatus`,
  `filledQty`, `avgPrice`, `shortRisks[]`. A refused ticket is HTTP 422
  `{ error: "<field>: <reason>" }`.
- `POST /api/portfolio/control/change` `{ orderId, qty?, limitPrice?, stopPrice?, trail?,
timeInForce? }` changes an open stock order. Answer `{ symbol, orderId (new), was,
change, shortRisks }`. Option orders keep their own controls (409 here).
- `GET …/control/stock/quote` now lists every open order of the stock, stops and trailing
  stops included, each with `type`, `timeInForce`, `limitPrice`, `stopPrice`,
  `trailPercent`, `trailPrice`, `extendedHours` (`price` is kept as before).
- `GET /v1/positions` `openOrders[]` adds `timeInForce`, `limitPrice`, `stopPrice`, and
  `type` is the broker's own type when it reports one.
- Cancel is unchanged: `POST …/control/cancel { orderId }`.

## Also fixed

- An open stock buy made every option buy check throw (it was read as an option
  position). The option checks now look at option orders only.
- An open stock sell read as `OVERSOLD` in the account-level short check (it compared it
  with option positions only), which would refuse every option buy. Shares are counted.
- The stop watch no longer treats a stock stop as an option stop-out to post.

## Verification evidence

- `npm run typecheck`, `npm test` (433: 432 pass, 1 skipped, 0 fail), `npm run build`.
  `npm run format:check` passes for every tracked file; it flags only untracked local
  files (`.claude/`, `.impeccable/`, `.idea/`).
- `tests/stock-tickets.test.ts`: type/price/time-in-force/extended-hours rules, tick,
  never-short sells and changes, dollars to shares, notes; on the simulator: market buy,
  resting gtc stop, trailing stop that follows and fires, stop moved and fired, check
  sends nothing, ioc canceled, stop limit buy, open stock orders not blocking option
  buys. `tests/position-control-api.test.ts`: only known fields reach the service.
- Not run: any order against Alpaca. Alpaca documents these equity types and times in
  force; `PATCH /v2/orders/{id}` with `trail` for a trailing stop is not yet verified on
  paper.

## Limitations

- Bracket, OCO and OTO orders are not offered: their legs appear as separate open sells,
  which the short check would count twice. That needs a paper check of how Alpaca lists
  legs first.
- Options keep their own flow (the stepped buy with an automatic stop). Alpaca documents
  only market and limit, day, for options.
- Alpaca may refuse a buy while an opposite sell order is open on the same stock
  ("potential wash trade"); its message is shown as it comes.
- No Telegram post for typed stock orders.

## Next

Frontend: on Trade → Shares, a side switch (Buy | Sell), order type, time in force,
the price fields the type needs, extended hours for limit, Check then Confirm; the open
orders list with change and cancel.
