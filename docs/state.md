# Current state

Updated: 2026-10-14
Phase: Alpaca live alerts on real-time SIP with Telegram delivery; marked-sections score vs SPY in review.

## History: cumulative P&L at trade closes

Cumulative realized P&L as a smooth monotone curve (no overshoot between
trades) on a true time axis (Israel time), one
dot per closed trade, green above zero and red below. The chart fills its
container width, uses rounded axis ticks and day-aligned date labels, and shows
a crosshair tooltip with the trade and cumulative result on hover, tap or
arrow keys. Dollar/percent controls use Alpaca's starting account value for
cumulative returns, rather than adding individual trade returns. Missing
starting equity disables percentage mode. In dollars, the graph starts at the period's
account base value and changes at each close, with vertical padding above and below the
balance range; percentage mode remains cumulative realized return. Unrealized P&L is not
part of this chart. The x-axis fits dates with closes while preserving their true spacing.

## Portfolio: pre/post-market option estimates

Option positions are repriced with Black-Scholes: volatility is implied from Alpaca's last
option mark at the underlying's one-minute bar of that moment (else that day's regular-feed
close, never the BOATS bar), then applied to the latest underlying print and the remaining
time to the expiry close, floored at intrinsic value. Without any volatility, a Greeks
expansion is used with theta capped at the remaining time value. See the
[review task](tasks/backend-trading-page-review.md). The view
also shows delta-adjusted exposure (contracts × 100 × underlying price × delta) and the
source times. This is a model estimate, not an executable option quote. Market-data
requests are cached for 10 seconds and fail open so the account positions still load.

When the US market is closed, the compact Close / Approx. now selector changes
the whole portfolio view. Account equity and open P&L, position marks, values,
P&L, account share and option delta exposure use the selected view. Approximate
position values are hidden when a usable estimate is unavailable, and the page
shows how many positions were priced. Cash and working orders do not change.

Validation: full check, including typecheck, all tests, and production build.

## Trade tab: stock price in the chain, confirmed stop moves

The option chain shows the stock's latest price as a row between the strikes around it
(as in IBKR) and tints in-the-money strikes; the chain's optional `underlyingPrice` is
null when Alpaca's latest stock trade cannot be read. Moving or setting a stop now asks
for Confirm/Cancel before anything is sent, like buys, sells and cancels; changing a
working buy's limit price still sends at once.
Validation: full check, chain/stop tests, and a 390px headless Chromium run with mocked
API responses (no POST until Confirm).

## Working product

The mobile replay site is published privately through Sites/Cloudflare Workers at
https://stock-market-assistant.alonmor89.chatgpt.site. It uses synthetic demo data or
uploaded historical JSON, not live market data. The shared relative-volume engine,
replay API, mobile layout and configurable thresholds/cooldown are implemented.
See [publication](tasks/sites-publication.md) and [alert contract](features/relative-volume.md).

## In review: engine tickers and two-hour cooldown

[Task](tasks/reduce-alert-noise.md), revised after the October 5 comparison.
rvol-v6 keeps both volume routes at 4×, sets a 120-minute cooldown per ticker
across sessions and directions, and restores delivered-alert cooldowns after
collector restarts. The new price/range gates and automatic liquidity/options
screening are withdrawn. Existing baseline movement checks stay as in rvol-v4.
Live → Manage engine tickers supports add/remove and sync retries; Live board
and Backtest use the authoritative shared list. The 35 stocks approved from
the previous report were removed from production D1 on October 7: 161 tickers
remain, including 19 unchanged ETFs. Running collector sync and code deployment
remain pending. No deployment or merge has been performed.

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
`rsScore`/`beta` and `vsSpy`; β/σ daily history is cached per day. The long explanatory
paragraph below the day chart has been removed for a cleaner view.

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
