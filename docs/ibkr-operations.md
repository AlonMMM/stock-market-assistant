# IBKR collector operation

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
