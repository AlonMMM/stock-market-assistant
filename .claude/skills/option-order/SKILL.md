---
name: option-order
description: Buy an option on the user's Alpaca account from a chat command such as "buy ORCL calls, delta 0.1, 0.5% of the portfolio", "buy NVDA puts 1%", or "put a stop on my AMD call". Previews the contract, waits for the user's choice, then sends the order with its stop. Use whenever the user asks to buy calls or puts, open an option trade, or add a stop to an option position.
---

# Option order

Places an option order through `scripts/option-order.ts`. Rules and limits are in
`docs/tasks/backend-option-orders.md`; read it only if something here is unclear.

Run the commands from the repository root. `npm run trade` loads the Alpaca and Telegram
keys from `.env` itself, taking the main checkout's file when a worktree has none. Never
read or print `.env`. If `npm run trade` is missing, this checkout is older than the
feature: say so and stop.

## 1. Read the command

| Value                     | Flag                | Default                                                 | Limit      |
| ------------------------- | ------------------- | ------------------------------------------------------- | ---------- |
| Stock                     | `--underlying`      | none: ask                                               |            |
| Call or put               | `--right call\|put` | none: ask                                               |            |
| Size, % of account equity | `--size`            | none: ask                                               | at most 3  |
| Delta                     | `--delta`           | 0.10–0.15, when the user names none: leave the flag out |            |
| Stop, % of the premium    | `--stop`            | 40                                                      | at most 70 |

Ask for a missing stock, direction or size in one short question. Do not guess them. If the
size is above 3 or the stop above 70, say the limit and ask for a new value.

## 2. Preview

```
npm run trade -- preview --underlying NVDA --right call --size 0.5 --stop 40
```

Add `--delta 0.2` only when the user named a delta. Without it the strike closest to the
middle of 0.10–0.15 is picked; if a row has `deltaInRange: false`, say that no strike of that
expiry falls in the range and which delta was picked.

Nothing is sent. Show each returned row in a short table: expiry, strike, delta, bid/ask,
spread % of mid, contracts, maximum cost, stop price. Say which account it is (`live: false`
is the paper account). If a row has `spreadOk: false`, say the buy will be refused for it
because the spread is above 10% of the mid.

Then ask which expiry to buy, and stop. Wait for the user's answer.

## 3. Buy, only after the user chose

Send the order only when the user picked a contract in this conversation, after seeing this
preview. A new command needs a new preview and a new choice.

```
npm run trade -- buy --contract NVDA261016C00242500 --size 0.5 --stop 40
```

The command asks the user for permission; that prompt is expected. Report from the output:

- `status`: `filled`, `partial`, `open` (nothing filled yet), `closed`, `rejected-spread`
  or `rejected-budget` (nothing was sent).
- Contracts filled and the average price.
- `stop`: the price it was placed at, or the error if Alpaca refused it.
- `raiseError`, if present: the price could not be raised (the usual cause is a closed
  market) and the order is still working at its last price.
- Whether the Telegram post was sent.

If the order is `open` or `partial`, say plainly that the unfilled contracts have no stop,
and that `stop` must be run once they fill.

## Stop for a position already held

```
npm run trade -- stop --contract NVDA261016C00242500 --stop 40
```

It places the stop at the position's average entry price less the stop %.

## Limits

- Paper account only. Never set `ALPACA_TRADING_LIVE`. If the user asks for a live order,
  say that live trading needs them to enable it themselves, and do not send it.
- Never retry a failed `buy` on your own: report the error and ask.
- The US options market is open 16:30–23:00 Israel time on trading days. Outside it an
  order is queued for the next open and its price is not raised; say so before buying.
- "Set ALPACA_API_KEY and ALPACA_API_SECRET" means no `.env` with the keys was found on
  this machine (a cloud session has none): tell the user, and do not ask for the keys in
  chat.
- Positions, stops and open orders are on the site under Portfolio → Live trades.
