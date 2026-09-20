# IBKR collector operation

Status: Railway waiting-mode collector deployed; browser Gateway migration in progress.

## Runtime

The private Sites application still uses synthetic replay data. Railway currently contains
a persistent Node collector and a separate login service. The collector must remain
IBKR_ENABLED=false until its TWS socket adapter is replaced with the Client Portal Web
API and real data has been validated.

The login service runs IBKR's official Client Portal Gateway behind nginx and HTTP Basic
authentication. It presents IBKR's normal browser SSO flow; it does not run a graphical
desktop, VNC or noVNC. The user enters brokerage credentials and completes 2FA directly in
IBKR's form. Credentials must never be requested in chat, stored in Git or automated.

## Browser authentication

1. Build Dockerfile.gateway. It downloads the official clientportal.gw.zip artifact and
   runs bin/run.sh root/conf.yaml as an unprivileged user.
2. Set GATEWAY_DESKTOP_PASSWORD to a random value of at least 32 characters. The legacy
   variable name is retained to avoid rotating the existing Railway secret; it now protects
   the browser proxy rather than a desktop.
3. Publish only nginx port 8080. Port 5000 remains loopback-only inside the container.
   /healthz is public for infrastructure liveness; every IBKR login/API route requires
   Basic authentication.
4. The user opens the HTTPS Railway domain, authenticates as trader, then signs in through
   IBKR SSO and approves 2FA. IBKR requires manual browser reauthentication approximately
   daily and does not support automated Client Portal Gateway login.
5. A single IBKR username can own only one brokerage session. The user temporarily approved
   the primary username; the steady state is a second username dedicated to collection.
   Market-data subscriptions are username-specific and may be billed separately.

## Collector migration gate

Client Portal Gateway is an HTTPS/WebSocket reverse proxy, not the TWS TCP protocol. Do not
point the existing @stoqey/ib adapter at port 5000. Before enabling live collection:

1. Implement a read-only Client Portal adapter for authentication status, contract lookup,
   historical one-minute bars and streaming market data.
2. Co-locate the adapter with Client Portal Gateway, or make all API calls through a proxy
   on that same runtime, matching IBKR's same-machine restriction.
3. Do not implement or forward order, account-position, funding or account-management
   endpoints.
4. Compare timestamps and volume for one symbol with IBKR, verify reconnect and daily
   reauthentication behavior, then expand to the 50-symbol watchlist.
5. Only after validation, set IBKR_ENABLED=true and connect the site's server to the
   bearer-protected collector API.

## Existing data behavior

The current fixture-tested engine stores normalized one-minute OHLCV bars and alerts in
SQLite, evaluates only closed minutes, warms relative-volume baselines from previous
sessions and never falls back to synthetic or delayed data. Persistent data remains at
/data; use one collector replica per database. /health reports per-symbol freshness and
/alerts returns stored alerts. Both require COLLECTOR_TOKEN.

## References

- [Client Portal Gateway authentication](https://www.interactivebrokers.com/docs/web-api/authentication/cpgw/installation-authentication)
- [Gateway limitations](https://www.interactivebrokers.com/docs/web-api/authentication/cpgw/limitations-of-the-client-portal-gateway)
- [Multiple sessions](https://www.interactivebrokers.com/docs/web-api/authentication/multiple-sessions)
- [Streaming market data](https://www.interactivebrokers.com/docs/web-api/trading/market-data/streaming-top-of-book-data)
- [Pacing limits](https://www.interactivebrokers.com/docs/web-api/trading/usage-and-availability/pacing-limitations)
