# Feature: listed traders and Interactive Brokers

Status: proposed (plan, 2026-10-17). Nothing here is implemented.
Owner: integration (cross-cutting plan); each phase below becomes its own task file.

## Agreed with the user (2026-10-17)

1. Listed people, not only the owner, trade through the trading service, each on their
   own brokerage account and only on their own command.
2. Interactive Brokers is a supported broker for every listed trader, not only the owner.
3. IBKR access is "path a": each trader creates a dedicated secondary IBKR username that
   only this service uses. The service keeps its password encrypted and runs an automated
   IB Gateway for it; the trader approves IBKR Mobile 2FA when the Gateway logs in.
4. No fixed per-person limits. Each trader points at a custom validator that we write
   for them; the trader record stores a pointer to it.
5. Notifications are not Telegram-only. Each channel has a `provider` enum
   (`telegram | whatsapp | discord | email`) and structured config for that provider.
   Only Telegram is implemented first.
6. The alert system runs only for the owner, on market data from the owner's IBKR
   account. Other traders get trading, not alerts.
7. The engine is cut to 75 tickers when alerts move to IBKR; no extra market-data lines.
8. The owner's trading moves to IBKR; Alpaca stays supported, and one user may hold
   accounts at both brokers.
9. A trader without a validator cannot buy until theirs is written.

## IBKR terms: blocks path a for other traders

IBKR's client agreements say the customer will not allow anyone to access their account
unless IBKR is notified and agrees, and will not let others use their username, password
or security device ([Client Agreement, SEC filing][ibkr-sec]; same rule in the 2023
margin agreement and the IBIE agreement, which asks for notice to
help@interactivebrokers.com and IBIE's written consent). Read against path a:

- Owner: the service is the owner's own software on the owner's own account. Allowed.
- Other traders: this service, run by the owner, would log in with their credentials.
  That is a third party using a customer's credentials and needs IBKR's written consent
  first. Not verified for each trader's IBKR entity; the agreement that applies to their
  account controls.

Consequence for the plan: IBKR for other traders is gated on (1) IBKR's written consent
after a notice, or (2) IBKR's third-party OAuth. Until then other traders use Alpaca.
Alpaca's own terms on using another person's API keys are not yet checked; its OAuth
app flow is the preferred way to connect them.

[ibkr-sec]: https://www.sec.gov/Archives/edgar/data/1948817/000194881723000011/IBKRClientAgreement_Official.txt

## Interpretations to confirm

- "Alert system" covers the relative-volume engine, its Telegram delivery and the
  engine watchlist. The site's board, day charts, vs-SPY scores and portfolio estimates
  keep using Alpaca data until a separate decision moves them.
- Other traders reach trading through the Claude connector first. Site pages for them
  (Portfolio, Trade) come in phase 3 and show only their own account.

## Architecture

```
Claude (each trader's own account)          Site (Cloudflare Access)
   │ MCP, OAuth via Cloudflare Access         │ Access JWT (already verified)
   ▼                                          ▼
Hosted Worker  /mcp, /api — verified email → caller id
   │ HTTPS + service token + caller email
   ▼
Trading service (Railway)                    apps/trader
   users ─ broker account ─ validator pointer ─ notification channels
   engine  hard rules → user's validator → order flow (unchanged)
   watch   never-short check per user, every minute (moves here from the Worker)
   vault   encrypted broker credentials
   │                       │
   ▼                       ▼
BrokerRegistry          NotifierFactory
   AlpacaTrading           telegram (first), whatsapp, discord, email
   IbkrBroker ──TWS API──► IB Gateway per IBKR trader (Railway, private network)
                                   ▲
Collector (owner only) ──TWS API───┘ owner's Gateway, separate clientId
```

## Data model (trader SQLite)

```
users
  id, email (unique, lower-case), display_name, enabled, is_admin,
  validator_id TEXT NULL,        -- pointer into the validator registry
  validator_params JSON NULL,    -- optional values that validator declares
  created_at, updated_at

broker_accounts                  -- several per user; one is the default
  id, user_id, broker ('alpaca' | 'ibkr'), mode ('paper' | 'live'), is_default,
  credentials BLOB,              -- AES-256-GCM, key TRADER_VAULT_KEY (Railway secret)
  gateway_url NULL,              -- ibkr: private host:port of that user's Gateway
  live_approved_by NULL, live_approved_at NULL,
  enabled, created_at, updated_at

notification_channels
  id, user_id, provider ('telegram' | 'whatsapp' | 'discord' | 'email'),
  config JSON,                   -- schema per provider; secrets inside are encrypted
  events JSON,                   -- subset of entry, exit, stop_out, short, gateway, alert
  enabled, created_at, updated_at
```

Existing tables (`jobs`, `posts`, `buys`, `decisions`, `notes`, `log`) already carry
`user_id` or get it; every query is scoped by it. Migration: the current single trader
becomes user `owner` with the existing Alpaca account, validator `owner-v1` and the
existing Telegram channel, so nothing changes for the owner on day one.

## Identity and the allowlist

- Connector: replace the fixed `MCP_TOKEN` with OAuth through Cloudflare Access for SaaS
  (already chosen as the option in `docs/tasks/backend-trading-service.md`). The Access
  policy's email list is the allowlist.
- Site: the Worker already verifies the Access JWT (`apps/api/src/access.ts`).
- The Worker forwards the verified email to the trader with the service token. The
  trader accepts a call only when the email maps to an enabled user. Both the Access
  policy and the `users` row must allow the person.
- Admin (owner) endpoints add, disable and list users; every change is in `log`.

## Validators

- Registry: `packages/trading/src/validators/index.ts` maps an id to a module that
  exports `validate(ctx): { ok, reasons[], hint? }` and an optional params schema.
- `ctx`: user, the requested order (buy or sell, stock or option), the chosen contract
  and quote, account, positions, open orders and the user's trade history today.
- Ids are code in Git, reviewed and tested. The service never loads a path, URL or
  uploaded script.
- `owner-v1` = today's `BuyLimits` checks plus the risk manager, moved without change.
- A user with no validator, or an unknown id, may not buy. Sells and stops stay allowed,
  so a held position can always be closed.
- Hard rules in the engine run before any validator and cannot be turned off by one
  (proposed split, to confirm):
  - never short; sells close-only and never more than held;
  - the global and per-user kill switches;
  - fresh quote, market open, no buy in a contract's last minutes.

## Notification channels

- `Notifier` stays the interface. `NotifierFactory(provider, config)` builds one; a
  fan-out sends each event to every enabled channel that subscribed to it.
- A failed channel never blocks or undoes an order (existing rule) and is logged.
- Config schemas (only telegram built now):
  - telegram `{ botToken, chatId, comments }`
  - whatsapp `{ phoneNumberId, to, accessToken }` (proposed)
  - discord `{ webhookUrl }` (proposed)
  - email `{ to }` (proposed, sent through one service account)
- New system events go to the user and to the owner: a short position found, a Gateway
  needing 2FA, a Gateway down.

## Interactive Brokers

### Interface: TWS API through IB Gateway

Change from the earlier proposal: with path a and no OAuth, the TWS API is the better
fit. IBC (in `ghcr.io/gnzsnz/ib-gateway`, used in `958cba2`) logs in headless and handles
2FA retries; streaming 1-minute bars for the collector exist only in the TWS API; and
`@stoqey/ib` was already used here (`11822bb`). If IBKR third-party OAuth is ever
approved, a Web API `IbkrBroker` can be added beside this one.

### Gateway per IBKR trader

- One Railway service per IBKR trader from `Dockerfile.gateway` (restore from `958cba2`),
  private network only, no public port. Trading mode follows the account's `mode`;
  `READ_ONLY_API=no` for trading.
- Credentials never pass through chat or Git. The trader enters them on the site's setup
  page; they are stored in the vault. At boot the Gateway fetches its own credentials
  from the trader over the private network with a token for that Gateway only.
- The trader approves IBKR Mobile 2FA after each full login (about weekly with IBC's
  daily restart). The service notifies the trader on their channels when a login waits
  for 2FA, and refuses that user's buys while the Gateway is down.
- Each trader must set up the secondary username themselves: options trading permission
  and their own market-data subscriptions (IBKR subscriptions are per username), US
  stocks and OPRA options.
- The owner's Gateway serves both the trader (one clientId) and the collector (another).
- Provisioning a new Gateway: an owner-run script using the Railway API
  (`scripts/ibkr-gateway.mjs add <user>`), not self-service.

### `IbkrBroker` against the `Broker` interface

- Contracts: OCC symbol ↔ IBKR `conId` through `reqContractDetails`, cached.
- `chain`: `reqSecDefOptParams` for expiries and strikes, then market-data snapshots with
  model Greeks for strikes near the target delta only (pacing limits).
- Orders: `LMT` DAY buys and sells, `STP` GTC stop on option contracts, changed in place
  (same order id). Stocks (`stockQuote`, `stockLimit`, `stockPositions`) with outside-RTH.
- Capabilities: `closeOnlyOrders: false` (IBKR will open a short on a sell), so the
  engine's held-quantity check before every sell is the hard gate, plus the per-user
  watch; `optionStops: true`; `replaceInPlace: true`; `paper` from the account mode.
- `equityHistory`: the TWS API has none. The service records each user's closing equity
  daily from the day the account is connected (Flex queries are a later option).
- Every check is tested against a fake TWS transport (as the old `IbkrFeed` test did),
  then on the owner's IBKR paper account before any live use.

### The never-short watch

The Worker cron cannot reach a Gateway on the private network. The watch moves into the
trading service, per user, every minute. The Worker cron stays as a heartbeat: it alerts
the owner when the trader's last watch is older than a few minutes.

## Owner's alerts on IBKR data

- Collector gets an `IbkrBars` source beside the Alpaca one (from `11822bb`'s
  `IbkrFeed`): `reqHistoricalData` warmup, then 1-minute bars with `keepUpToDate`.
  Only closed minutes are evaluated, as today; no fallback to delayed or synthetic data.
- `MARKET_DATA_SOURCE=ibkr | alpaca` selects it. Cutover only after a shadow run of at
  least three sessions in which both sources' bars and alerts are compared.
- The engine is cut to 75 tickers (user, 2026-10-17). That fits the default 100
  market-data lines and leaves room for the owner's trading quotes on the same
  username. Historical-data pacing still slows the warmup.
- The watchlist sync stays as it is (Claude routine through the IBKR connector).
- Alerts are delivered only to the owner's channels with the `alert` event.

## Phases

| #   | Task (owner)                                         | Done when                                                                                                                                                                                              |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Multiple traders on Alpaca (backend)                 | Users, scoped store, broker registry, validator registry with `owner-v1`, channels (telegram), watch in the trader. Owner's behavior unchanged; a second Alpaca paper user is fully isolated in tests. |
| 2   | Connector sign-in per person (backend + integration) | `/mcp` uses Access OAuth; an unlisted or disabled email is refused; the connector text names the user's broker, not Alpaca.                                                                            |
| 3   | Setup and admin pages (product-ux → frontend)        | A trader connects a broker and channels; the owner manages the allowlist; site trade pages show only the caller's account.                                                                             |
| 4   | Owner's IBKR Gateway (backend)                       | Owner's Gateway runs on the private network, logs in with credentials from the vault, 2FA and down notices reach the channels.                                                                         |
| 5   | `IbkrBroker` (backend)                               | Every trade flow passes on fake TWS and on the owner's IBKR paper account: buy with raises, stop, sell at bid, never-short refusal, stocks.                                                            |
| 6   | Owner's alerts from IBKR (backend)                   | Shadow run of ≥3 sessions matches Alpaca within agreed tolerances; cutover by config.                                                                                                                  |
| 7   | Live accounts (integration)                          | Each live account approved separately by the owner, with its own switch.                                                                                                                               |
| 8   | IBKR for other traders (integration)                 | Only after IBKR's written consent or third-party OAuth (see "IBKR terms"). Then one Gateway per trader, by the owner's script.                                                                         |

Phases 1–2 do not need IBKR. Phase 4 can start in parallel with 2–3.

## Open questions

1. Confirm the hard-rule split under Validators.
2. Who pays for each trader's Gateway service on Railway (one Java process, about 1 GB
   of memory each), once phase 8 is allowed?
3. Send IBKR the notice and consent request (help@interactivebrokers.com), or apply for
   third-party OAuth, or both?
4. Which broker account does a connector command use when a user has two: the default,
   unless the command names the broker?
