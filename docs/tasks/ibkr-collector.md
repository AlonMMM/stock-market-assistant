# Task: IBKR market-data collector

Status: blocked on cloud connection and user brokerage authentication for deployment
Owner: integration
Branch: feat/ibkr-collector

## Outcome

Replace synthetic input with IBKR minute bars for up to 50 configurable US stocks.
User confirmed real-time/API entitlements; no account positions or trading requested.

## Implementation

Read-only TypeScript market-data adapter, previous-session warmup, closed-minute updates,
calendar/volume normalization, existing relative-volume engine, durable SQLite bars/alerts,
bearer-protected health and alert endpoints, collector container packaging and runbook.
The website remains the published synthetic replay application until the cloud collector
and Gateway are connected and the website's authenticated live integration is completed.

## Acceptance and evidence

Fixture tests cover repeated cumulative updates, closed candles, DST/session boundaries,
volume scaling, missing full historical dates, stale/warmup suppression, DB restart and
deduplication, request parameters and entitlement errors. Repository check, collector
bundle and doctor passed. No actual IBKR handshake or cloud/container runtime verified.
Docker is not installed here. No UI changes in this increment; browser suite not rerun.

## Handoff

See [operations](../ibkr-operations.md). Connect hosting, provision Gateway with secure
interactive authentication, verify real volumes, connect live website API/UI, then phone
delivery. No cloud account or broker credentials are available in the current session.
