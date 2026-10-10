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

- **Contract:** the strike whose |delta| is closest to the requested delta. The preview
  shows two expiries side by side: the nearest listed one and the coming Friday's (the last
  listed expiry up to that Friday). The user picks one.
- **Size:** each command states its own size as % of account equity; 3% is the hard maximum.
  Whole contracts are sized at the ceiling price, so the cost stays within the size.
- **Price:** a day limit order starts at the mid and is raised every few seconds (default
  5 raises, 3 s apart), with a fresh quote each time, up to 85% of the way from mid to ask.
  It is never lowered. A partial or zero fill at the ceiling is left working and reported.
- **Spread guard:** if (ask − bid) / mid exceeds 10%, nothing is sent and the user is told.
  If the spread widens past 10% while the order is working, raising stops and it is reported.
- **"Real value":** the mid is used as the estimate of fair value. The user questioned this;
  see the open questions below.

## Usage

```
node --import tsx scripts/option-order.ts preview --underlying ORCL --right call --delta 0.1 --size 0.5
node --import tsx scripts/option-order.ts buy --contract ORCL261016C00250000 --size 0.5 --delta 0.1
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
- `packages/trading/src/message.ts`: the group message (placeholder format).
- `scripts/option-order.ts`: `preview` and `buy`.

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
- Not yet run: price raises on a live order and fill reporting. They need market hours.

## Open questions and next steps

1. Indy's post format: the research was not found in the repo, Notion or Drive. Until the
   user provides examples, `formatEntry` posts a simple placeholder.
2. Fair value for the spread guard: mid, or size-weighted mid (microprice)?
3. Tick sizes assume the penny program ($0.01 below $3, $0.05 from $3); a contract outside
   the program may reject a price, and the error is reported as is.
4. Exit/update messages and selling are not implemented.
