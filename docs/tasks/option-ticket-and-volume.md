# Task: Broker-style option ticket; volume on the watchlist

Status: completed (in review)
Branch: feat/option-ticket

## Outcome

User request (2026-10-17): "on the watchlist I want to add total volume today as
well. In the option trade I want an IBKR-like page for buying the option + checkbox
for using the try to buy and increase + checkbox with auto stop."

## Watchlist

- A sortable **Volume** column (desktop): shares traded in today's regular session so
  far, the same figure Rel vol is measured from. On a phone it stays under Last, now
  marked "vol".

## Option ticket (Trade → Options)

- Laid out like a broker's ticket: BUY and the contract, a bid/mid/ask/spread/delta
  strip, quantity (contracts by default, or % of the account), order type and time in
  force (limit, day: Alpaca's only time in force for options), the limit price with
  −/+ one tick and Bid/Mid/Ask, Preview, then Submit and Confirm.
- **Try to buy and increase** (on by default): the stepped buy as before, from the mid
  toward the ask, the unfilled part canceled after 2 minutes. Off: one day limit order
  at the price given (`ladder: false`, `limitPrice`), sized and checked at that price.
- **Auto stop** (on by default) with its %. Off (`autoStop: false`): no stop is placed;
  the risk checks count the whole premium as at risk, and the preview says that, while
  "positions without a stop" holds, every later buy is refused until it has one.
- A limit order with auto stop is watched for 15 minutes for fills to protect, then the
  rest is canceled; without auto stop it is left at the broker for the day and the
  result says so ("still working … Cancel it from Orders").
- Refused: a limit price off the tick, `limitPrice` without `ladder: false`, and a
  limit order without a stop that adds to a contract held with a stop (its stop would
  stay off all day).

## Contract

`POST /api/portfolio/control/check` and `…/buy` accept `ladder` (boolean),
`limitPrice` (number) and `autoStop` (boolean); the check answers `ladder`,
`limitPrice`, `autoStop`, and `stopAtCeiling: null` without a stop. The finished job
adds `working` and `noStop`. Requests without these fields work exactly as before
(the Claude connector included).

## Verification evidence

- `npm run typecheck`, `npm test` (461: 460 pass, 1 skipped), `npm run build`,
  Prettier on every changed file.
- Simulator tests (`tests/trade-engine.test.ts`): one order at the limit with its stop;
  a limit without a stop left working; stepped without a stop; check at a limit; bad
  choices; adding without a stop refused. `tests/position-control-api.test.ts`: the
  site passes the three fields on and refuses bad shapes. `tests/order-run.test.ts`,
  `tests/chain-model.test.ts`, `tests/live-model.test.ts`.
- Headless Chromium at 390 and 1280 px: the option ticket with SYNTHETIC answers
  (nothing sent); the watchlist with real prices on a temporary local list (deleted).
- Not run: an order against Alpaca with the new choices.

## Limitations

- No market order for options: Alpaca allows one, but a market order on a wide option
  spread is risky; the Ask button gives a marketable limit instead.
- The option ticket buys only; selling stays under Live trades.
