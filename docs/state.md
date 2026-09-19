# Current state

Updated: 2026-09-19
Phase: IBKR collector implemented; live deployment blocked on external connections.

## Working product

The mobile replay site was published privately through Sites/Cloudflare Workers at
https://stock-market-assistant.alonmor89.chatgpt.site. It uses synthetic demo data or
uploaded historical JSON, not live market data. The shared relative-volume engine,
replay API, mobile layout and configurable thresholds/cooldown are implemented.
See [publication](tasks/sites-publication.md) and [alert contract](features/relative-volume.md).
Earlier statements that no deployment existed are superseded by this publication.

## Current increment

User chose IBKR price/volume data, confirmed API entitlements, reduced initial scope to
50 configurable US tickers and authorized autonomous implementation and deployment.
User uses IBKR only on the phone. Do not ask again for entitlement proof.

The separate Node collector implements minute TRADES warmup/updates, closed-bar handling,
calendar/volume normalization, durable SQLite and authenticated health/alert endpoints.
It is tested with fixtures, not connected to IBKR. No cloud server was provisioned.
Railway is available but unconnected. Brokerage login must happen directly by the user.
See [task](tasks/ibkr-collector.md) and [operations](ibkr-operations.md).

## Verification

Repository checks (format, types, tests, web/Worker build), collector bundle and doctor
passed. Tests cover data correctness, restart persistence and adapter behavior with a
fake transport. Actual Gateway compatibility, real data accuracy, container runtime and
cloud operations are unverified. Docker is unavailable. No UI changed in this increment.

## Next

Connect hosting, provision a private authenticated Gateway, validate live data, connect
collector to website, then implement phone push. Charts remain pending. GitHub main last
checked still contains the harness; replay/mobile PRs remain separate. No merge performed.

## Conventions

TypeScript, React and Node; AGENTS.md is canonical. Per-role Claude sessions use isolated
worktrees. Only task-planner and reviewer agents are authorized; neither is implemented.
