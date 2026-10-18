# Task: Option limit buys, debit spreads, IBKR-style expiry tabs

Status: active
Owner: integration
Branch: frontend/side-by-side-chain
Spec/contract revision: user decisions of 2026-10-17 (below)

## Outcome

On Trade → Options the owner can:

- buy one contract at their own limit price instead of the automatic mid → ask raises;
- buy a two-leg debit spread (buy one strike, sell another of the same stock, side and
  expiry) at a net limit price, and later close it as one order;
- pick expiries from IBKR-like tabs.

## Decisions (user, 2026-10-17)

- Never short, amended: a short option is allowed only when a long option of the same
  underlying, right and expiry covers it as a debit vertical (call: long strike at or
  below the short; put: long strike at or above). Anything else stays a short-risk alert.
- Debit spreads only. Their most possible loss is the net debit, so they are sized on it
  (size % of the account = at most that % at risk) and get no stop. Brokers take no
  stop orders on multi-leg orders.
- A limit buy of one contract is a day order. The service keeps a stop on every contract
  that fills until the order fills or ends at the close.

## Scope and exclusions

- Alpaca only for spreads (multi-leg `order_class: mleg`); IBKR answers "not supported".
- Exclusions: credit spreads, more than two legs, ratios other than 1:1, calendars,
  closing one leg alone (refused: close the spread), rolling.

## Acceptance criteria

- A covered short leg raises no short-risk alert; an uncovered one still does. A sell
  order on a spread's long leg (stop or limit) counts as a short risk.
- A buy is not refused for "positions without a stop" because of a spread's long leg,
  and open risk counts a spread at its net debit.
- Selling, resizing or stopping one leg of a spread is refused with "close the spread".
- Spread check: same underlying/right/expiry, debit orientation, net debit above zero and
  below the strike width, size, buying power, open risk, buys per day, day loss, trading
  switched on, paper. A refused spread sends nothing.
- A limit buy sends one day order at the user's price; stops cover each fill.
- Off hours both wait at the broker for the open, like other option orders.

## Addition (user, 2026-10-18): IBKR-like phone chain, OI and IV

- The chain scrolls inside its box both ways; the page does not. It opens with the
  strike column and the stock's price line in the middle. The strike column and the
  price tag stay in view when the sides are scrolled.
- Columns per side, outermost first: OI, IV, spread, delta, bid, ask. Phones no longer
  hide the spread column; they scroll to it.
- Chain contract, additive: each quote has `iv` (a fraction) and `openInterest`, both
  `null` when unknown. Alpaca: IV from the option snapshots, OI from
  `/v2/options/contracts` (the previous close's count); a failed OI read leaves the
  chain shown with no OI. IBKR: IV from the model computation tick; OI is `null`
  because a TWS snapshot does not carry it.
- Evidence: `npm run typecheck` clean, `npm run build` passes, `git diff --check`
  clean; `npm test` 482 tests, 479 pass, the same 2 Windows-only failures as below.
  New test: the Alpaca chain's IV and OI, and the chain without OI. Headless Chrome
  screenshots with synthetic data at 1100px and in a 390px frame (centered, scrolled
  to each edge). Not run against Alpaca: the `open_interest` field follows its docs.

## Verification evidence

- `npm run typecheck`: clean. `npm run build`: passes. `git diff --check`: clean.
- `npm test`: 481 tests, 478 pass. The 2 failures (IB Gateway IBC config, session
  launcher) also fail on `main` in this Windows checkout.
- tests/spreads.test.ts (13): pairing and the amended short rule, stop and risk
  accounting, spread checks (credit and over-width refused), open and close with the
  simulated broker, one leg refused alone, the own-limit buy, the site's request
  validation, the trading service's jobs, and the exact Alpaca `mleg` request body and
  read-back of an open multi-leg order.
- Headless Chrome screenshots at 1100px and 390px with synthetic mocked data: spread
  picking and its checked ticket, the limit ticket, the expiry strip, and the
  portfolio's Spreads panel.
- Not run against Alpaca: the `mleg` shape follows Alpaca's docs (positive
  `limit_price` = debit, negative = credit; open orders list with an empty `symbol` and a
  `legs` array when `nested=true`).

## Handoff

- Before relying on it: one paper spread, opened and closed. Some Alpaca users report a
  multi-leg close refused as "uncovered short contracts"; if so, the close needs a
  fallback (buy the short leg back first, then sell the long one).
- A limit buy or spread order works until the close; the page stops following it after
  about 5 minutes and says it is still working.
- After a restart the service withdraws a job's open spread order and alerts.
