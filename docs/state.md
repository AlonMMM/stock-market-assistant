# Current state

Updated: 2026-09-20
Phase: Railway runtimes deployed; switching IB Gateway to phone-friendly automation.

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
It is fixture-tested and deployed to Railway in an intentionally disabled waiting state.
The Client Portal Gateway experiment failed because IBKR requires its authentication
browser and API caller to run on the same machine as that Gateway. OAuth is not an
immediate alternative for an Individual account. The user therefore selected the
automated IB Gateway with IBC-assisted login and the TWS API. A live test of the earlier
manual desktop authenticated but returned to login after three seconds without opening its
API listener; phone operation was also impractical.
See [task](tasks/ibkr-collector.md) and [operations](ibkr-operations.md).

## Verification

Repository checks (format, types, tests, web/Worker build), collector bundle and doctor
passed. Tests cover data correctness, restart persistence and adapter behavior with a
fake transport. Actual market-data compatibility and real data accuracy are unverified.
Docker is unavailable locally. The Railway collector passed its waiting-mode test. The
automated IB Gateway runtime still requires Railway credential secrets, IBKR Mobile 2FA and
a one-symbol real-data comparison before the collector can be enabled.

## Next

Deploy the automated IB Gateway, approve 2FA, validate real data,
connect the collector to the website, then implement phone push.
Charts remain pending. Replay/mobile and collector work remain on review branches.

## Conventions

TypeScript, React and Node; AGENTS.md is canonical. Per-role Claude sessions use isolated
worktrees. Only task-planner and reviewer agents are authorized; neither is implemented.
