# Task: Broker-style option ticket with every order type; phone Trade screen; volume

Status: completed (in review)
Branch: feat/option-ticket-v2 (replaces PR #103, built on #107)

## Outcome

User requests (2026-10-17/18): an IBKR-like ticket for buying an option, a checkbox for
"try to buy and increase", a checkbox for auto stop, the missing order types, the whole
chain visible on a phone and a nicer phone screen, and today's volume on the watchlist.
Layouts follow the prototypes in `docs/features/option-ticket-mockup/` (PR #108): B
(chain and order panel side by side) on wide screens, C (a sheet over the bottom) on
phones, A's preview numbers in both.

## Order types (Alpaca, docs.alpaca.markets/docs/options-trading)

Market, limit, stop and stop limit for one option; day or GTC. No trailing stop for
options. `packages/trading/src/option-tickets.ts` holds the rules:

- No `orderType`: the usual stepped buy (mid → ask, the rest withdrawn after 2 minutes),
  day only. "Try to buy and increase" on the ticket = this.
- `limitPrice` alone stays the plain day limit buy of #107.
- Prices on the option tick (0.01 below $3, 0.05 from $3). Sized and checked at the
  order's own price: the limit; the ask for market; the stop or the ask, the higher, for
  a stop buy.
- With auto stop, the order is watched and every fill gets its stop: a day order until
  the close (off hours, the next one), a GTC order until the contract expires. A restart
  cancels the open order and puts a stop on what is held, as before.
- `autoStop: false`: no stop. A typed order is then left at the broker, not watched; the
  stepped buy is watched only to withdraw what did not fill. Risk checks count the whole
  premium, and the preview says that "positions without a stop" refuses later buys until
  it has one. Adding to a contract held with a stop without one is refused (its stop
  would stay off).
- IBKR: only limit buys (no `optionBuy`); other types are refused by name.

## Screens

- Wide (≥1100px): the page widens to 1240px; the chain shows every column of both sides
  beside a 360px order panel that stays in view.
- Phone (≤720px): one row for Options/Shares, the stock and Show; Calls | Puts picks the
  side; the chain shows Strike, Bid, Ask, Delta, IV, OI with no sideways scroll; the
  order is a sheet folded to its title bar above the section tabs, opened by tapping a
  contract or Order.
- Watchlist: a sortable Volume column (today's regular-session shares); under Last on a
  phone, marked "vol".

## Contract

`POST /api/portfolio/control/check` and `…/buy` also take `orderType`, `stopPrice`,
`timeInForce` and `autoStop: false`; the check answers `orderType`, `limitPrice`,
`stopPrice`, `timeInForce`, `autoStop`. A finished job adds `working` and `noStop`.
Requests without them work as before (the Claude connector included).

## Verification evidence

- `npm run typecheck`, `npm test` (514: 513 pass, 1 skipped), `npm run build`,
  Prettier on every changed file.
- Simulator: market buy filled with its stop; GTC stop buy without auto stop left
  working, triggers later with no stop; stepped without a stop; stop limit sized at its
  limit; ticket rules; adding without a stop refused. Site and service pass and check the
  fields. Web: form → request, ticks, result text, volume sort.
- Headless Chromium at 390 and 1280 px with SYNTHETIC answers (nothing sent).
- Not run against Alpaca: market, stop, stop limit and GTC option orders follow its docs.
