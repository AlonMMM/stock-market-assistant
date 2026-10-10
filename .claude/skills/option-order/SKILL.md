---
name: option-order
description: Buy an option on the user's Alpaca account from a chat command such as "buy ORCL calls, delta 0.1, 0.5% of the portfolio", "buy NVDA puts 1%", "sell half NVDA", or "put a stop on my AMD call". For a buy it previews the contract, waits for the user's choice, then sends the order with its stop; for a sell it sells at the bid. Use whenever the user asks to buy calls or puts, open an option trade, sell or exit an option position, or add a stop to one.
---

# Option order

Places an option order through `scripts/option-order.ts`. Rules and limits are in
`docs/tasks/backend-option-orders.md`; read it only if something here is unclear.

Run the commands from the repository root. `npm run trade` loads the Alpaca and Telegram
keys from `.env` itself, taking the main checkout's file when a worktree has none. Never
read or print `.env`. If `npm run trade` is missing, this checkout is older than the
feature: say so and stop.

## The rule that comes first: never short

The account must never be short an option. If any command prints `ALERT: SHORT OPTION
RISK`, or exits with code 2, put that alert at the very top of your reply, in bold, with
every line it printed, before anything else. Do not send further orders and do not try to
fix it yourself: tell the user and wait. `npm run trade -- check` runs the same check on
its own; run it when the user asks whether the account is safe.

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

The command asks the user for permission; that prompt is expected. It raises the price for
about 20 seconds, then watches the order for 2 more minutes, placing and enlarging the stop
as contracts fill, and cancels whatever has not filled. Tell the user it can take up to
about two and a half minutes. Report from the output:

- Contracts filled and the average price (`result.order`).
- `canceledQty`: contracts that did not fill and were withdrawn.
- `stop`: its price and the contracts it covers. If `stop.qty` is below the filled
  quantity, or `stop.error` is set, say plainly which contracts have no stop and that
  `stop` must be run for the contract.
- `cancelError`, if present: the unfilled part could not be withdrawn and may still fill
  without a stop.
- `rejected-spread` or `rejected-budget`: nothing was sent.
- Whether the Telegram post was sent. None is sent when nothing filled.

## Sell

For "sell half NVDA", "sell all NVDA", "get out of AMD", "sell 3 ORCL":

```
npm run trade -- sell --underlying NVDA --qty half
```

`--qty` is `all`, `half` (rounded up) or a number of contracts. Ask only if the user gave no
quantity. No preview: the permission prompt is the confirmation. If the output says there
are several positions in the stock, show them and ask which, then pass `--contract`.

It sells at the bid and follows the bid every 5 seconds until everything has sold, for up
to 2 minutes. Report: contracts sold and the average price, profit or loss, what is still
held, and the stop on it (`stop.error` means the remainder has no stop: say so). If
`timedOut` is true, say how many did not sell.

## Stop for a position already held

```
npm run trade -- stop --contract NVDA261016C00242500 --stop 40
```

It places the stop at the position's average entry price less the stop %.

## Limits

- There is no market-order exit and no profit target; say so if asked.
- Paper account only. Never set `ALPACA_TRADING_LIVE`. If the user asks for a live order,
  say that live trading needs them to enable it themselves, and do not send it.
- Never retry a failed `buy` on your own: report the error and ask.
- The US options market is open 16:30–23:00 Israel time on trading days. Outside it nothing
  fills, and the order is canceled after the wait; say so before buying.
- "Set ALPACA_API_KEY and ALPACA_API_SECRET" means no `.env` with the keys was found on
  this machine (a cloud session has none): tell the user, and do not ask for the keys in
  chat.
- Positions, stops and open orders are on the site under Portfolio → Live trades.
