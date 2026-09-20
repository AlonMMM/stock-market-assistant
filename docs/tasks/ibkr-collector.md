# Task: IBKR market-data collector

Status: Railway deployed in waiting mode; graphical IB Gateway deployment in progress
Owner: integration
Branch: feat/ibkr-collector

## Outcome

Replace synthetic input with IBKR minute bars for up to 50 configurable US stocks.
User confirmed real-time/API entitlements; no account positions or trading requested.

## Implementation

Read-only TypeScript market-data adapter, previous-session warmup, closed-minute updates,
calendar/volume normalization, existing relative-volume engine, durable SQLite bars/alerts,
bearer-protected health and alert endpoints, collector container packaging and runbook.
The website remains the published synthetic replay application until IB Gateway/TWS data
is validated and the website's authenticated live integration is completed.

## Acceptance and evidence

Fixture tests cover repeated cumulative updates, closed candles, DST/session boundaries,
volume scaling, missing full historical dates, stale/warmup suppression, DB restart and
deduplication, request parameters and entitlement errors. Repository check, collector
bundle and doctor passed. The Railway collector container works in waiting mode. Docker is
not installed locally. The Client Portal reverse-proxy experiment was rejected after live
authentication failed IBKR's same-machine requirement; the existing TWS adapter is again
the selected feed and remains disabled until interactive login and real-data validation.

## Handoff

See [operations](../ibkr-operations.md). Authenticate through the protected remote desktop,
configure read-only TWS access, verify real volumes, connect the live website API/UI, then
phone delivery. Never request brokerage credentials in chat.
