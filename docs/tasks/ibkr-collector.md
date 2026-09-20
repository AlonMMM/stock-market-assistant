# Task: IBKR market-data collector

Status: Railway deployed in waiting mode; Client Portal Web API migration in progress
Owner: integration
Branch: feat/ibkr-collector

## Outcome

Replace synthetic input with IBKR minute bars for up to 50 configurable US stocks.
User confirmed real-time/API entitlements; no account positions or trading requested.

## Implementation

Read-only TypeScript market-data adapter, previous-session warmup, closed-minute updates,
calendar/volume normalization, existing relative-volume engine, durable SQLite bars/alerts,
bearer-protected health and alert endpoints, collector container packaging and runbook.
The website remains the published synthetic replay application until Client Portal Web API
data is validated and the website's authenticated live integration is completed.

## Acceptance and evidence

Fixture tests cover repeated cumulative updates, closed candles, DST/session boundaries,
volume scaling, missing full historical dates, stale/warmup suppression, DB restart and
deduplication, request parameters and entitlement errors. Repository check, collector
bundle and doctor passed. The Railway collector container works in waiting mode. Docker is
not installed locally. The TWS adapter is incompatible with Client Portal Gateway and
remains disabled while the Web API adapter is implemented.

## Handoff

See [operations](../ibkr-operations.md). Authenticate through the protected browser page,
replace the collector feed with Client Portal REST/WebSocket, verify real volumes, connect
the live website API/UI, then phone delivery. Never request brokerage credentials in chat.
