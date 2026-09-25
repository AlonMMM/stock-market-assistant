# Task: Alpaca market-data collector

Status: implementation complete; Railway credentialed validation pending
Owner: integration
Branch: feat/alpaca-data-provider

## Outcome

Replace the IBKR runtime with Alpaca minute bars for up to 50 configurable US stocks,
without account, position or trading access.

## Acceptance

- Historical one-minute bars warm the existing RVOL baseline.
- One authenticated WebSocket subscribes to closed one-minute bars for the watchlist.
- IEX is the default; SIP and delayed SIP are explicit configuration options.
- Provider credentials and error bodies never enter logs or Git.
- The collector remains bearer-protected and stores normalized bars/alerts in SQLite.
- Fixture tests cover REST pagination/authentication, stream authentication/subscription,
  live bar conversion, sanitized failures and disabled startup.

## Handoff

Deploy with `ALPACA_ENABLED=false`, add the two Alpaca secret variables in Railway, set
`ALPACA_SYMBOLS=AAPL`, then enable and inspect health/live bars before expanding to 50.
See [operations](../alpaca-operations.md).
