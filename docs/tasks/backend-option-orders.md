# Task: Option orders from a chat command

Status: active
Owner: backend
Branch: ccr-907dbc30-jqxd6w

## Outcome

The user writes a command such as "buy ORCL calls, delta 0.1, 0.5% of the portfolio" to a
Claude session. Claude previews the contract, buys it on Alpaca after the user approves,
and posts the entry to a dedicated Telegram group.

The user explicitly authorized order execution on the Alpaca **paper** account
(2026-10-10). Live trading needs a separate authorization.

## Rules (user-confirmed 2026-10-10)

- **Never short (hard rule, user 2026-10-10):** the account must never be short an option,
  and the user must be alerted if it ever is. Enforced in four places:
  1. Every sell order, limit or stop, is close-only (`position_intent: sell_to_close`).
     Verified on the paper account: Alpaca refuses such an order when no contracts are held
     (422 "position intent mismatch"). Every buy is `buy_to_open`.
  2. Quantities are read fresh from the position. `sell` takes the stop off and waits for
     the broker to confirm it is gone before selling anything; a stop only ever covers
     contracts that no other open sell order covers (`uncovered`).
  3. After every `buy`, `sell` and `stop`, and on `npm run trade -- check`, the account is
     checked (`shortRisks`): a negative option position, or open sell orders for more
     contracts than are held, prints `ALERT: SHORT OPTION RISK`, is posted to the trades
     channel and ends the command with exit code 2.
  4. `/api/portfolio` returns the same findings as `shortRisks`, shown as a red banner on
     Portfolio → Live trades.
  5. The hosted Worker runs the same check every minute, all week (cron in
     `wrangler.jsonc`, `packages/trading/src/watch.ts`), so it does not depend on a command
     or an open page. A finding is posted to the trades channel, repeated every 15 minutes
     while it lasts, and followed by a post when it is gone. Five failed checks in a row
     are posted too. The Worker needs the secrets `TRADES_TELEGRAM_BOT_TOKEN` and
     `TRADES_TELEGRAM_CHAT_ID`, and its Alpaca keys must be the trading account's.

- **Contract:** the strike whose |delta| is closest to the requested delta. Without a delta
  in the command the range 0.10–0.15 applies (user-confirmed 2026-10-10): the strike closest
  to its middle, flagged when the expiry has none inside the range. The preview
  shows two expiries side by side: the nearest listed one and the coming Friday's (the last
  listed expiry up to that Friday). The user picks one.
- **Size:** each command states its own size as % of account equity; 3% is the hard maximum.
  Whole contracts are sized at the ceiling price, so the cost stays within the size.
- **Price:** a day limit order starts at the mid and is raised every few seconds (default
  5 raises, 3 s apart), with a fresh quote each time, up to 85% of the way from mid to ask.
  It is never lowered.
- **Spread guard:** if (ask − bid) / mid exceeds 10%, nothing is sent and the user is told.
  If the spread widens past 10% while the order is working, raising stops and it is reported.
- **Stop (user-confirmed 2026-10-10):** every buy gets a stop loss as a share of the premium
  paid: 40% by default, 70% at most (`--stop`). A larger value is refused before anything is
  sent. The stop price is the average fill price less that share, rounded up to a tick. It
  is a good-till-canceled stop order: once a trade prints at or below the stop it becomes a
  market sell (Alpaca's rule for option stops).
- **After the raises (user-confirmed 2026-10-10):** `buy` watches the order for 2 minutes
  (`--wait`, seconds). Each time more contracts fill, the stop is placed or enlarged to cover
  all of them, priced from the average fill. What has not filled by the end is canceled, so
  nothing can fill later without a stop. A stop the broker refuses while the buy is open is
  tried again after the cancel. With nothing filled, no channel post is sent. This also
  applies outside market hours: a queued order is canceled after the wait.
- **Selling (user-confirmed 2026-10-10):** `sell --underlying NVDA --qty all|half|N` sells
  at the bid: a day limit sell at the current bid, re-priced to the new bid every 5 seconds
  until it has all sold. Half rounds up. The position's stop is canceled first, because the
  broker reserves the contracts for it, and placed again at the same price on whatever is
  still held; a remainder that had no stop gets the default one. After `--wait` seconds
  (120) an unsold order is canceled and reported. The exit is posted to the channel as a
  reply to the entry post, whose id is kept in `data/local/trade-posts.json`.
- **"Real value":** the mid is used as the estimate of fair value. The user questioned this;
  see the open questions below.

## Usage

```
npm run trade -- preview --underlying ORCL --right call --size 0.5 [--delta 0.1]
node --import tsx scripts/option-order.ts buy --contract ORCL261016C00250000 --size 0.5 [--stop 40]
node --import tsx scripts/option-order.ts stop --contract ORCL261016C00250000 [--stop 40]
```

Environment: `ALPACA_API_KEY`, `ALPACA_API_SECRET` (or `APCA_API_KEY_ID`,
`APCA_API_SECRET_KEY`); `ALPACA_OPTIONS_FEED` (`opra` default, `indicative` without an
OPRA subscription); `ALPACA_TRADING_LIVE=true` for the live account (off by default);
`TRADES_TELEGRAM_BOT_TOKEN`, `TRADES_TELEGRAM_CHAT_ID` for the group. Network access to
`paper-api.alpaca.markets`, `data.alpaca.markets` and `api.telegram.org`.

## Code

- `packages/trading/src/options.ts`: OCC parsing, expiry choice, delta pick, spread guard,
  tick rounding, price steps, sizing.
- `packages/trading/src/ladder.ts`: the stepped limit order.
- `packages/trading/src/alpaca-trading.ts`: account equity, option snapshots, orders.
- `packages/trading/src/message.ts`: the channel post, in the format of Indi's entry posts
  (`$TICKER | strike Call/Put expiry`, `Bought at X`, `N contracts`) plus the stop line.
- `scripts/option-order.ts`: `preview`, `buy` and `stop`.

## Verification evidence

- `npm test`: 263 pass, 0 fail, including `tests/option-orders.test.ts` (synthetic quotes
  and a fake broker client).
- `npm run format:check` and `tsc -p tsconfig.json` pass.
- Paper account, 2026-10-10 (Saturday, closing quotes from Friday): `preview` works with the
  OPRA feed and reads equity ($100,000). 0.1-delta contracts on ORCL, SPY, QQQ, NVDA, AAPL,
  TSLA and AMD, calls and puts, both expiries: 5 of 25 exceed the 10% spread guard (ORCL call
  19.6%, AAPL 11.3% / 13.1% / 22.2%, AMD put 12.5%); SPY, QQQ, NVDA and TSLA are 1.5–7.1%.
- `buy` on a contract over the guard (ORCL261016C00155000) returned `rejected-spread` and
  sent nothing.
- `buy` of 1 AMD261016C00660000 on paper with the market closed: the order was accepted at
  the mid (1.67) and queued. Alpaca then refused the first raise (422 "cannot replace order
  in accepted status") and the script crashed without a report. Fixed: a refused raise now
  stops the raising, leaves the order working and is reported as `raiseError`. The test
  order was canceled.
- Telegram: the trades bot posts to its own channel; sample entry posts were sent through
  `formatEntry` and `TelegramSender` (no order behind them).
- Stop: `buy --stop 80` is refused before any order; `preview` shows the stop at the ceiling
  price. The stop order itself has not been sent to Alpaca.
- Watch and cancel, paper account, market closed (2026-10-10): `buy --wait 9` of 1
  AMD261012C00627500 was accepted at 1.03, the raise was refused, and after 9 s the order
  was canceled at Alpaca (`status: canceled`, `canceledQty: 1`); no post was sent.
- `sell`: covered by tests on a fake broker only. Against Alpaca it has only been run
  with no position (it answers "No option position"). The unverified parts are how soon
  the contracts are free after the stop is canceled, and the average price when a
  re-priced order had partly filled.
- Not yet run: price raises on a live order, fill reporting, and placing the stop. They
  need market hours.

## Portfolio tab (Live → Portfolio)

`GET /api/portfolio` (local API and Worker) reads the Alpaca trading account with GET
requests only: equity, change since the previous close, cash, open positions and open
orders. Each position carries its stop (the open sell stop orders for the contract): price,
loss from entry, money at risk, and the quantity covered. `riskAtStops` sums that risk;
`unprotected` counts positions with no stop or a partial one. Paper account unless
`ALPACA_TRADING_LIVE=true`; the keys must belong to the selected account. Code:
`packages/trading/src/portfolio.ts`, `apps/web/src/Portfolio.tsx`,
`tests/portfolio.test.ts`.

Verified 2026-10-10: `npm run check` passes (270 pass, 1 skipped). Locally the tab shows
the real paper account (empty: $100,000, no positions or orders). Positions, stops and
orders were checked in headless Chrome at phone and desktop widths with SYNTHETIC data
only. Not deployed: the hosted Worker would use its own `ALPACA_API_KEY`, which may belong
to a different account than the local paper keys.

### Portfolio area (2026-10-10, branch feat/portfolio-area)

Portfolio is now its own area next to Live and Backtest, with two tabs. Live trades is the
view above. History reads `GET /api/portfolio/history?period=1W|1M|3M|1A`: Alpaca's daily
profit and loss for the period (chart on top), and the trades closed in it, paired from the
account's latest 500 fills (`closedTrades`). A trade runs from the first buy of a contract
until the position is back to zero; an expiry closes it at zero. Answers are reused for a
minute.

Verified: `npm run check` passes (273 pass, 1 skipped); the real paper account shows a flat
line and no trades. The chart and closed trades were checked in headless Chrome with
SYNTHETIC data only. Not verified against Alpaca: the shape of expiry (`OPEXP`) activities,
since the account has none.

## Open questions and next steps

1. Stop orders on thin options: the stop sells at market once triggered, so on a wide
   spread the exit can be well below the stop price. A stop-limit avoids that but may not
   fill. Also unverified: whether Alpaca accepts the stop while part of the buy is still
   working. A refusal is reported and posted as "No stop".
2. Fair value for the spread guard: mid, or size-weighted mid (microprice)?
3. Tick sizes assume the penny program ($0.01 below $3, $0.05 from $3); a contract outside
   the program may reject a price, and the error is reported as is.
4. Exit/update messages and selling are not implemented.
