# Task: IBKR broker for the owner (paper)

Status: active (in review)
Owner: backend
Branch: feat/ibkr-broker
Spec/contract revision: docs/features/multi-user-ibkr.md, phase 3

## Outcome

The owner can trade the IBKR paper account through the trading service, next to Alpaca,
with the same flow, validator and channels.

## Scope

- `packages/trading/src/ibkr-trading.ts`: `IbkrTrading implements Broker` over a small
  `TwsClient` view: OCC ↔ IBKR contracts, TWS → Alpaca order statuses, close-only check on
  every sell, chain of out-of-the-money strikes (30% reach, 30 strikes per expiry).
- `packages/trading/src/tws-client.ts`: `StoqeyTws`, the `TwsClient` over `@stoqey/ib`
  1.6.10.
- `apps/trader`: one trader per broker account (records of a non-default account under
  `<user>/<account>`), `X-Trader-Broker` / `broker` to pick it, `IBKR_GATEWAY` adds the
  owner's IBKR paper account, `ShortWatch` every minute for brokers without close-only
  orders.

Deferred: daily equity history for IBKR (the risk manager sees none), strikes beyond the
30% reach, the connector's `broker` tool parameter, the never-short watch for Alpaca moving
from the Worker.

## Verification evidence

- `tests/ibkr-trading.test.ts` (11) and new `tests/traders.test.ts` cases: pass with a fake
  TWS client. Full local test run: 464 pass, 0 fail.
- `tws-client.ts` was type-checked locally against declarations generated from the
  library's 1.6.10 source; only `once`/`off` (from `eventemitter3`, not installed locally)
  were unresolved. The full `npm run check` with the real package runs in CI.
- Not verified: a real connection to the Gateway, the account-summary tag
  `PreviousDayEquityWithLoanValue`, and snapshot deltas on the paper account.
