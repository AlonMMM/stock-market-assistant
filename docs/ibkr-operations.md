# IBKR collector operation

Status: implemented and fixture-tested; not connected to the user's account or deployed.

## Runtime

The existing private Sites/Cloudflare Worker site remains a synthetic replay workspace.
The collector is a separate long-running Node 24 process connecting over a private TCP
network to an authenticated IB Gateway. It serves authenticated `/health` and `/alerts`
endpoints. No website proxy or live UI has been enabled yet, and no phone push is sent.

The user confirmed API market-data entitlements and authorized implementation/deployment
for up to 50 US stocks. Do not ask for screenshots or re-confirm those permissions.
The editable 50-symbol starting list is `config/ibkr-watchlist.json`; it is a development
default, not a list selected by the user or a trading recommendation.

## Startup and deployment

1. Provision a private IB Gateway runtime with secure interactive login access. The user
   logs in directly and completes IBKR authentication; do not request a password in chat.
   Enable socket clients and **Read-Only API**, port 4001 for the live Gateway. Restrict
   trusted IPs to the collector. Never publish port 4001, VNC, or a login desktop publicly.
2. Set variables described in `config/collector.env.example`. `IBKR_VOLUME_UNIT` must match
   the Gateway setting: shares (the preferred setting), or lots (multiplied by 100).
   Generate a random `COLLECTOR_TOKEN` in the deployment secret manager.
3. Build `docker build -f Dockerfile.collector -t sma-collector .` and run with a persistent
   volume at `/data`. A newly mounted volume must be writable by container uid 1000.
   Set `IBKR_HOST` to the Gateway's private hostname. In a container, 127.0.0.1 is the
   container itself, not another Gateway container. Use one replica per database.
4. Run under a supervisor with a restart delay of at least 60 seconds, and bounded retries
   for repeated authentication/entitlement failures. Errors terminate visibly; a restart
   rebuilds engine state from persisted bars and backfills the current session. Configure
   alerts for crash loops, missing bars and disk usage. Do not treat HTTP liveness as a
   successful IBKR subscription.
5. Connect the site's server to the collector over HTTPS, keeping its bearer token on the
   server. This integration is pending the actual deployment endpoint, not simulated.
6. Before enabling user notifications, compare a symbol's timestamps and volumes with IBKR,
   then expand to 50. Check restart behavior, permission failures, pacing, mobile concurrent
   login behavior and Gateway reauthentication on the user's actual account.

Local development: Node 24, `npm ci`, then `npm run start:collector` with those environment
variables. `npm run build:collector` creates `dist/collector.mjs`. The Dockerfile packages
the collector only; it does **not** install IB Gateway or automate brokerage login.

Railway was discovered as an available but unconnected hosting integration. The user must
connect their cloud account before provisioning can happen here. No cloud resources were
created, no billing was incurred, and no Gateway runtime is available in this workspace.
Gateway provisioning and its secure phone-accessible login remain part of deployment work.

## Data behavior and limitations

- Requests one-minute `TRADES` bars with `useRTH=false` and Unix start timestamps; the same
  IBKR historical service supplies warmup and `keepUpToDate` updates. Updates replace
  cumulative volume, never add it twice. A newer minute confirms the prior bar has closed.
  The last bar before a halt/session end may wait for the next update; it is not fabricated
  by a timer. Bars older than two minutes can repair history but do not emit live alerts.
- Warmup requests each of the previous 20 exchange dates per ticker, one request at a time
  with a 1.2-second gap. A first cold start may take tens of minutes. An API timeout or
  error stops the process; there is no silent synthetic/delayed fallback.
- Existing cached dates are reused. Partial dates produce insufficient-history for missing
  windows; automated repair of older partial days is not yet implemented. Failed/ambiguous
  tickers currently stop the collector rather than silently dropping symbols.
- Require every minute in the matching window on all expected prior trading dates, including
  when an entire day is missing. Warmup and reconnect do not publish historical crossings.
- Calendar coverage is 2026–2028; enough earlier dates must also be covered for warmup.
  Unscheduled closures need a calendar update. DST uses America/New_York. Extended hours
  are 04:00–20:00 ET on normal days. Post-market is excluded on early-close days because
  venue hours differ; missing sessions are never assigned normal-day hours.
- SQLite stores prices, volumes and alerts, keyed by ticker/end. Bars retain 120 calendar
  days; alerts currently retain indefinitely. Use persistent storage and backups. No broker
  password/account identifier is requested or stored. Do not run two collectors on one DB.
- Pinned community TypeScript adapter `@stoqey/ib` 1.6.10 exposes the TWS protocol. Live
  compatibility with the installed Gateway version still requires an integration test.
- A subscriber state is not proof of freshness. `/health` includes each symbol's last bar
  and age; downstream UI must show stale/closed-market states explicitly.

## References

- [IBKR API](https://www.interactivebrokers.com/docs/tws-api/doc/introduction)
- [Historical updates](https://www.interactivebrokers.com/docs/tws-api/doc/market-data-historical/historical-bars/keep-up-to-date)
- [Volume units](https://www.interactivebrokers.com/docs/tws-api/doc/market-data-historical/historical-data-limitations/historical-volume-scaling)
- [Calendar](https://www.nyse.com/trade/hours-calendars)
- [TypeScript client](https://stoqey.github.io/ib-doc/)
