# Current state

Updated: 2026-10-03
Phase: Alpaca live alerts on real-time SIP with Telegram delivery; marked-sections score vs SPY in review.

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

## Since 2026-09-25 (merged to main; deployment state not re-verified here)

Telegram alert notifications with deep links to the Live view (#24, #25), per-alert
analysis with Telegram follow-ups and a site panel (#26–#30,
[spec](features/alert-analysis.md)), and the alert feed grouped by Israel date (#31).

## In review: marked-sections score vs SPY

[Spec](features/marks-vs-spy.md). Replaces the area score: only the green/red marked
minutes count, each sized by the stock's 5-min move minus β × SPY's, linearly weighted over
the 60 minutes before the alert (its own minutes excluded), scaled by the same minute's
20-session σ. Charts show a contributions pane; after hours the board and charts show the
closing score. Worker subrequests stay ≤ 40 per request.

## Merged: area score vs SPY

[Spec](features/area-vs-spy.md). Replaces the day-based vs-SPY score and its labels: a
linearly weighted area between the stock and β×SPY since the session open, scaled by the
same minute's 20-session σ (50 = normal). Shown in Telegram, alert tags, the day chart
(with a gap pane) and the watchlist. The board's σ work is bounded to ≤ 40 Worker
subrequests per poll.

## Merged: alert score vs SPY and real-time SIP

[Spec](features/alert-vs-spy.md). Each live alert carries its vs-SPY score and a
direction label (confirmed / against / with market) in Telegram and on the site, with a
live "now" score for today's alerts; Backtest alerts carry the alert-time score. The SIP
delay is configurable (`ALPACA_SIP_DELAY_MINUTES`, 0 on Algo Trader Plus). Rollout:
[real-time SIP](alpaca-operations.md#real-time-sip-rollout).

## Merged: day chart vs SPY

[Spec](features/chart-vs-spy.md). All day charts: no entry/stop marks, price next to
each %, green = stronger / red = weaker than SPY, and a 0–100 score vs SPY (shared with the
alert analysis) in the chart and as a watchlist column. Board and day-chart APIs add
`rsScore`/`beta` and `vsSpy`; β/σ daily history is cached per day.

## Backtest page redesign (merged in #35)

[Spec](features/backtest-page.md). Grouped setup with presets and rule-change tracking,
the look-now score as the primary grade ([spec](features/look-now-score.md)) with
stop/target as a collapsed trade view, and Alerts / By symbol / Data quality tabs.
`/api/backtest` adds `validation.baselineBySymbol`. Verified with `npm run check` and
synthetic headless-browser checks only.

## Live page redesign (merged in #32)

[Spec](features/live-page.md). Status pill beside the title, market strip, Alerts and
Watchlist tabs, a sortable watchlist table with relative volume and day range, and a
two-axis day chart with typical volume per minute and opposite-to-benchmark bands.
Backend adds board `stats`, day-chart `typicalVolume` and the shared `opposite()`.
Verified with `npm run check` and synthetic headless-browser checks only; real Alpaca and
collector data, thresholds and rel vol accuracy are unverified. See the
[backend](tasks/backend-live-page.md) and [frontend](tasks/frontend-live-page.md) tasks.

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
