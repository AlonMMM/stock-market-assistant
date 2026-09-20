# IBKR collector operation

Status: Railway waiting-mode collector deployed; graphical IB Gateway deployment in progress.

## Runtime

The private Sites application still uses synthetic replay data. Railway contains a
persistent Node collector and a separate official IB Gateway service. The collector stays
disabled until the user logs in, enables read-only API access and one symbol is validated.

IB Gateway runs with a virtual Linux display. nginx publishes only a Basic-Auth-protected
noVNC page so the user can operate that display from a phone browser. VNC itself listens on
loopback. Brokerage credentials are entered only into IB Gateway and must never be requested
in chat, stored in Git or automated.

## Interactive authentication

1. Build `Dockerfile.gateway`; it downloads IBKR's official stable standalone installer.
2. Set `GATEWAY_DESKTOP_PASSWORD` to a random value of at least 32 characters.
3. Publish nginx port 8080. `/healthz` is public for liveness; the desktop requires Basic
   authentication. Ports 5900 and 6080 remain loopback-only.
4. The user opens the Railway HTTPS domain on the phone, authenticates as `trader`, and
   signs in inside IB Gateway. The user completes IBKR Mobile 2FA directly.
5. In IB Gateway settings, enable socket clients, select read-only API access, use the live
   trading port, and allow only the collector's private connection. Do not expose the TWS
   socket on a public Railway domain.
6. A single IBKR username may lose or compete for its active brokerage session. The primary
   username is temporary; the intended steady state is a dedicated second username.

## Collector activation gate

1. Connect the existing TWS adapter to the Gateway over Railway private networking.
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
