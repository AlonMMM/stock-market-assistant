# Task: multi-user core, one user

Status: active (in review)
Owner: backend
Branch: feat/multi-user-core
Spec/contract revision: 2604dc8 (docs/features/multi-user-ibkr.md, phase 1)

## Outcome

The trading service is built from a store of traders instead of one set of environment
variables. The owner is the only trader and notices no change: same Alpaca paper keys,
same Telegram channel, same limits.

## Scope and exclusions

In scope:

- `users`, `broker_accounts` and `notification_channels` tables (`apps/trader/src/store.ts`).
- Secret references `{ env }` / `{ vault }` and AES-256-GCM sealing with `TRADER_VAULT_KEY`
  (`apps/trader/src/secrets.ts`). Optional until a sealed secret is stored.
- On the first start with no user, the owner is seeded from today's variables
  (`apps/trader/src/seed.ts`): `TRADER_USER`, `TRADER_OWNER_EMAIL` (optional), the Alpaca
  keys and the `TRADES_TELEGRAM_*` variables, all stored as `{ env }` references.
- Validator registry (`packages/trading/src/validators.ts`): `owner-v1` = the default buy
  limits and the risk manager, unchanged. No validator or an unknown id refuses buys.
  The engine runs a validator's extra checks after its own (`validate` option).
- Notification fan-out with provider enum and event filter
  (`packages/trading/src/fan-out.ts`); only telegram is built.
- `Traders` registry (`apps/trader/src/traders.ts`): one service per enabled user on their
  default account. Requests name the trader in `X-Trader-User` (email or id); without it,
  the owner. Unknown or disabled callers get 403. Jobs and conflicts are scoped per user.

Deferred:

- The never-short watch moves into the service with `IbkrBroker` (phase 3); the Worker
  cron still watches the owner's Alpaca account.
- Choosing a broker account per command (phase 3), admin endpoints and the Worker sending
  `X-Trader-User` (phases 6–7).
- Stock buys do not run the validator yet; they keep their own checks.

## Acceptance criteria

- The owner's flows are unchanged: every existing trader, engine and connector test passes.
- A second user cannot see or cancel the owner's jobs and trades only its own broker.
- A user without a validator is refused with a `validator:` reason.
- Live accounts and unsupported brokers fail to build; plain-text secrets are rejected.

## Verification evidence

- `npm run check` (2026-10-17): format, types, 429 tests (428 pass, 0 fail, 1 skipped,
  pre-existing), builds. New: `tests/traders.test.ts`, 8 tests.
- `npm run build:trader`: bundles.
- Local start with synthetic keys: the owner is seeded, `/health` answers, an unknown
  `X-Trader-User` gets 403, the owner's request reaches Alpaca (401 for the fake keys).
- Not verified: a start against the existing production database and real keys.

## Handoff

Deploy needs no new variable. On the first start of this version the owner row is created
from the current variables; later changes to those variables still apply because the rows
hold references, not values. Next: phase 2 (owner's IBKR Gateway).
