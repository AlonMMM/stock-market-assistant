# Task: Alpaca historical backtest

Status: implemented; credentialed Alpaca validation pending
Owner: backend (web screen included at the user's request)
Branch: feat/alpaca-backtest
Spec/contract revision: [relative volume v1](../features/relative-volume.md)

## Outcome

The user picks symbols and a date range and sees the relative-volume alerts the live
collector would have sent at those times. The results can be downloaded as JSON to review
the signal and prepare bot-training data.

## Scope and exclusions

- `POST /api/backtest` on the local API and the hosted Worker, and a Backtest mode on the site.
- Alpaca SIP historical one-minute bars only; no account, position or order endpoints.
- Signal reconstruction only: no forward returns, P&L or trade simulation.
- Limits: 1–10 symbols, at most 20 trading sessions, dates within the 2026–2028 calendar
  (the 20 warmup sessions before the start must also fall inside it).

## Acceptance criteria

- Bars are normalized with the collector's calendar and replayed through `LiveEvaluator`,
  so alerts, cooldown, suppression and missing-day handling match live behavior.
- Warmup sessions build the baseline without producing alerts.
- The most recent 15 minutes are never requested (Alpaca's free-plan SIP restriction).
- Sessions without bars are reported per symbol.
- Missing credentials return 503, invalid input 400, provider failures 502 without
  response bodies or credentials.

## Verification evidence

- `tests/backtest.test.ts`: synthetic Alpaca fixtures cover alert reconstruction, cooldown
  suppression, missing sessions, the 15-minute cutoff, validation, and local/Worker parity.
- `npm run check`: passed (27 tests, builds).
- The Backtest screen was exercised in Chromium at 360 and 390 px against a local API
  backed by synthetic Alpaca responses (not real data): two alerts rendered, no horizontal
  overflow, and Replay mode still works.
- Not verified: real Alpaca credentials, SIP entitlement, and actual volumes. This cloud
  environment blocks `data.alpaca.markets`.

## Handoff

1. Run locally with keys in `.env` (see [operations](../alpaca-operations.md)), and compare
   one alert's volume with Alpaca's chart.
2. Set the same two secrets on the hosted Worker before using Backtest on the site.
3. Integration: record the new endpoint in `docs/state.md` after merge.
