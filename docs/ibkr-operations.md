# IBKR operation

## Trading Gateway (owner, paper) — 2026-10-17

Phase 2 of [listed traders and Interactive Brokers](features/multi-user-ibkr.md). One
`ib-gateway` Railway service runs the owner's IB Gateway through IBC
(`Dockerfile.gateway`, `deploy/gateway/start.sh`). The trading service connects to it
over Railway's private network on port 4001; no public domain points at it.

- Paper only: `start.sh` exits unless `TRADING_MODE=paper`. Live needs the owner's
  separate approval and a dedicated username (one IBKR username has one brokerage
  session, so a live Gateway login would disconnect IBKR Mobile).
- The API is open for orders (`READ_ONLY_API=no`): the trading service sends them.
- For now it logs in with the paper username of the owner's regular IBKR user. While
  IBKR Mobile streams live data, the paper account may get delayed or no data.

Setup:

1. Railway: new service `ib-gateway` from this repository, `RAILWAY_DOCKERFILE_PATH=Dockerfile.gateway`,
   a volume at `/home/gateway`, no public domain.
2. Variables, entered by the owner in the Railway dashboard only (never in chat, Git or a
   terminal command that is shown in a conversation): `TWS_USERID` (paper username),
   `TWS_PASSWORD`, `TRADING_MODE=paper`, `TWS_ACCEPT_INCOMING=accept`,
   `TWOFA_TIMEOUT_ACTION=restart`, `RELOGIN_AFTER_TWOFA_TIMEOUT=yes`.
3. The logs show IBC's login and then the API listener; the trading service then reaches
   `ib-gateway.railway.internal:4001`.

### Trading service connection (phase 3)

- `sma-trader` variables: `IBKR_GATEWAY=ib-gateway.railway.internal:4001` adds the
  owner's IBKR paper account (not the default) on the next start; `IBKR_CLIENT_ID`
  (default 11) is the API client id of that connection.
- A call names the broker with `X-Trader-Broker: ibkr` (or `broker` in the body or
  query); without it, the default account (Alpaca) is used.
- IBKR does not refuse a sell that opens a short. `IbkrTrading` checks every sell
  against what is held and already offered, and the trading service checks the IBKR
  account for short risk every minute (alerts repeat every 15 minutes).
- Real-time market data only (`reqMarketDataType(1)`); no delayed or frozen quotes.
- `BOT_BROKER=ibkr` makes the Indi bot trade this account instead of its Alpaca one
  (docs/tasks/backend-bot-ibkr.md); unset, the bot stays on Alpaca.
- TWS has no daily account history: the trading service records the IBKR account's value
  every minute of a trading day (`equity_days` in its SQLite), and the risk manager's
  drawdown brake reads that series. It starts on the first connected day.

## History: read-only collector (September 2026, replaced by Alpaca)

Status: Railway waiting-mode collector deployed; automated IB Gateway deployment in progress.

## Runtime

The private Sites application still uses synthetic replay data. Railway contains a
persistent Node collector and a separate automated IB Gateway service. The collector stays
disabled until the user approves 2FA and one symbol is validated.

The version-pinned Gateway image uses IBC to fill the login dialog, apply read-only API
settings and handle routine dialogs. Brokerage credentials are Railway secrets: never ask
for them in chat, commit them to Git or expose them in logs. The public remote desktop is no
longer part of normal operation.

## Authentication

1. Build `Dockerfile.gateway`; it pins the maintained automated Gateway image.
2. Set `TWS_USERID` and `TWS_PASSWORD` directly as Railway service secrets. Never send
   either value in chat.
3. Set `TRADING_MODE=live`, `READ_ONLY_API=yes`, `TWS_ACCEPT_INCOMING=accept`,
   `TWOFA_TIMEOUT_ACTION=restart` and `RELOGIN_AFTER_TWOFA_TIMEOUT=yes`.
4. Keep persistent settings in `/home/gateway/automated`. The earlier manual runtime remains
   untouched under `/home/gateway/Jts` for rollback.
5. The user only approves IBKR Mobile 2FA. No remote desktop configuration is required.
6. Use a dedicated IBKR username. A single username cannot keep simultaneous active trading
   sessions in IBKR Mobile and IB Gateway.

## Collector activation gate

1. Connect the existing TWS adapter to private port 4001, bridged to the image's live-mode
   socat port 4003.
2. Confirm `/health` reports an authenticated feed without entitlement errors.
3. Compare timestamps and volume for one liquid symbol with IBKR, then expand to the
   configured 50-symbol watchlist.
4. Confirm reconnect, closed-minute behavior and persistent SQLite writes.
5. Only then set `IBKR_ENABLED=true` and connect the site's server to the bearer-protected
   collector API.

No order, position, funding or account-management operations are implemented. The engine
stores normalized one-minute OHLCV bars and alerts, evaluates only closed minutes and never
falls back to synthetic or delayed live data. Use one collector replica per `/data` volume.

## OAuth note

OAuth 2.0 is not available to Individual account structures. OAuth 1.0a third-party access
requires IBKR onboarding, a mature proof of concept, compliance review and legal approval.
It may be reconsidered if this becomes an external commercial product.

## References

- [TWS API initial setup](https://interactivebrokers.github.io/tws-api/initial_setup.html)
- [Client Portal Gateway limitations](https://www.interactivebrokers.com/docs/web-api/authentication/cpgw/limitations-of-the-client-portal-gateway)
- [OAuth 2.0 registration](https://www.interactivebrokers.com/docs/web-api/authentication/oauth-2/register)
- [Third-party OAuth 1.0a registration](https://www.interactivebrokers.com/docs/web-api/authentication/oauth-1a/third-party-oauth/registration-process)

## Watchlist sync

The watchlist comes from the user's IBKR watchlist "Favorites" (IBKR id `10`, confirmed
2026-09-27). It is account data, so it is not in Git: the Railway collector stores it in
its SQLite database. `PUT /watchlist` on the collector replaces it, accepting either
`COLLECTOR_TOKEN` or the narrower `WATCHLIST_SYNC_TOKEN` (which may call nothing else).
The first `ALPACA_MAX_SYMBOLS` (default 30, the free IEX stream limit) are streamed
live; a change to that set resubscribes in place. The site reads the list from the
collector (`/api/watchlist`) and falls back to `config/alpaca-watchlist.json`.

The sync is weekly (user decision 2026-09-27) plus on demand: a Claude routine, created
by the user, reads the list with the IBKR connector (`get_watchlist`, read-only), drops
futures (`contract_id_ex` containing `@`) and sends
`{"name": "Favorites", "tickers": [...]}` to `PUT /watchlist` with the sync token. The
servers never call IBKR themselves.
