# Current state

Updated: 2026-09-25
Phase: replacing IBKR Gateway with Alpaca Market Data.

## Working product

The mobile replay site is published privately through Sites/Cloudflare Workers at
https://stock-market-assistant.alonmor89.chatgpt.site. It uses synthetic demo data or
uploaded historical JSON, not live market data. The shared relative-volume engine,
replay API, mobile layout and configurable thresholds/cooldown are implemented.
See [publication](tasks/sites-publication.md) and [alert contract](features/relative-volume.md).

## Current increment

The user replaced IBKR with Alpaca as the market-data provider. The Node collector now
uses Alpaca historical one-minute bars for warmup and one authenticated market-data
WebSocket for live closed bars across up to 50 configurable US symbols. It retains the
calendar normalization, relative-volume evaluator, durable SQLite store and protected
health/alert endpoints. IEX is the default feed; SIP is configurable for an entitled plan.
The implementation never calls account, position or order APIs. See the
[task](tasks/alpaca-collector.md) and [operations](alpaca-operations.md).

## Verification

Adapter and collector unit tests pass with synthetic Alpaca REST/WebSocket fixtures.
Actual Alpaca credentials, provider compatibility and live volume accuracy remain to be
validated. The existing Railway collector must be redeployed in disabled mode, receive
Alpaca credentials through Railway secrets, and then be enabled for AAPL first.

## Next

Deploy the Alpaca collector, add keys, validate AAPL historical/live bars, then expand to
50 symbols. Connect the collector to the website and implement phone push afterward.
Charts remain pending. Do not delete the old Gateway service until Alpaca validation passes.

## Conventions

TypeScript, React and Node; AGENTS.md is canonical. Per-role Claude sessions use isolated
worktrees. Only task-planner and reviewer agents are authorized; neither is implemented.
