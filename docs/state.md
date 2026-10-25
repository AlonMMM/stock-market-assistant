# Current state

Updated: 2026-10-15
Phase: Live stock-market assistant with Alpaca market data, alerts, backtesting, portfolio/history, and paper options support. Production validation and next priorities are tracked in the [product backlog](product-backlog.md).

## Indi bot on the paper account (2026-10-21, in review)

The backtested Indi rules trade the owner's Alpaca paper account from the trading service.

- **Signal:** C signal on the stocks he traded in the past year, t ≥ 1.8 (V2, `feat/indi-bot-v2-rules`, not
  merged; was 2). Backtest at 1%: $585,592 / worst drop 11% (t ≥ 2: $297,160 / 16%).
- **Contract and size:** delta 0.15, 2% a trade.
- **Exits:** your stop, plus the overnight hold. V2: one contract holds at most 10% of the account overnight
  (the `nightCapPct` setting, 0 = off); the excess is sold at 15:50 ("night cap"). Scale-in was tested and not
  used.
- **News filter (V2 champion, `feat/indi-bot-news-filter`, not merged):** no new entry on a stock's earnings
  reaction day (Nasdaq calendar) or with pre-market volume 4× its 20-session median. Fails open if a source fails.
  Backtest at 1%: $297,160 / worst drop 16% (V1 $257,698 / 26%).
- **Where it shows:** posts marked 🤖 Bot in the same Telegram chat; a 🤖 Bot tab and Bot chips in Portfolio.
  The Bot tab names contracts in words ("Put 75 · 2DTE").
- **Switches:** off and dry-run by default (`BOT_ENABLED`, `BOT_MODE`).
- **Orders (2026-10-23):** buys chase the ask until filled (up to 10 minutes, at most 10% over the
  budget), sales wait at the bid up to 10 minutes, and the exit checks run every 10 s on the
  stock's last trade. See "Orders and timing" in [the bot task](tasks/backend-indi-bot.md).
- **Own account (2026-10-23, `feat/bot-account`, deploy pending):** with `BOT_ALPACA_API_KEY` /
  `BOT_ALPACA_API_SECRET` the bot trades a second paper account of the owner's, and Portfolio gets a
  read-only **Bot trades** tab for it (`/api/portfolio/bot`). See
  [the task](tasks/backend-bot-account.md).
- **Portfolio navigation (2026-10-25, `feat/portfolio-two-tabs`):** two tabs, Trade (Live trades · New trade ·
  Orders · History) and 🤖 Bot (Activity · Trades · Settings), each with a pill row of pages that remembers where
  it was; the owner-only pages (New trade, Settings) are hidden from visitors. Was six flat tabs.
- **Option bid / ask on every bot record (2026-10-25):** the accounts are paper accounts, so their fills are not
  real-world prices. Both bots (Indi and Alert leg) keep the option's bid / ask at the decision: on the signal (the
  contract picked, a too-cheap one too), on each account's buy (`entryBook`) and on every sale or order (`book`), each with the broker whose quote it is (alpaca or ibkr), in
  the trading service's SQLite (`apps/trader/src/option-book.ts`). Records before this date have none.
- **IBKR (2026-10-24, #140 and #142 deployed):** the Bot settings page gets a Broker
  switch (Alpaca | Interactive Brokers | Both) for new entries; a position is sold where it was bought. "Both"
  buys the same contract at each account, to compare fills and fees; the Bot trades tab shows either account by
  toggle (IBKR through the trader). IBKR is the owner's paper account
  behind the Gateway (the account `IBKR_GATEWAY` adds); `BOT_BROKER` is only the default before a save; market
  data stays Alpaca. The service records the IBKR account's value daily (`equity_days`), so the risk
  manager's drawdown brake works there too. The Bot trades tab still shows the Alpaca bot account. See
  [the task](tasks/backend-bot-ibkr.md).
- **Versions (2026-10-23, `feat/bot-version`):** the rules have a version (1.0 the first bot, 2.0 the V2
  champion, 2.1 with the failed-break sale, 2.2 with the t-stat exit of 2026-10-24, 2.3 holding overnight from +50%, 2.4 with the rest at −20% after the 10-minute half); every signal, position and buy note is stamped with the version in
  force (starred when its rules were changed), and the owner picks the version on the settings page. See
  "Versions" in [the settings task](tasks/backend-bot-settings.md).
- **Parity:** signal and exits match the Python backtest exactly (26,049 stock-days, 875 trades).
- **Fixed on the news-filter branch:** the live bars reader took Alpaca's start times (seconds) as milliseconds, so
  the deployed bot on `main` would read no bars and never signal.

See the [task](tasks/backend-indi-bot.md).

## In progress: the alert leg, a second bot (2026-10-25)

A separate bot on its own Alpaca paper account (`STRANGLE_ALPACA_API_KEY`), with its own Portfolio tab
(🎯 Alert leg: Activity, Trades, Settings): on the first volume alert of an expiry day it waits for the side (a
quarter of the stock's typical 30-minute move), buys only that side's 0.35-delta same-day leg and sells when the
stock gives back 0.75 of that move from its best. Parity 497/499 with the backtest. Waiting for the account;
starts off and in dry run. See the [task](tasks/backend-strangle-bot.md).

## Live prices every second: Watchlist and charts (2026-10-19)

`GET /api/prices?symbols=…` answers Alpaca's latest SIP trade for every symbol in one
request. The page reads it once a second, one request shared by everything on screen,
while the tab is visible and the session shown is trading (04:00–20:00 New York):

- Watchlist: each price is the close of its 5-minute bar, so Last, Change %, vs
  SPY/sector, the day line and the day range follow every trade; Rel vol, volume and
  the score still come from the 5-minute board.
- Candle chart (Watchlist rows, stock page) and full screen: the trades build the
  forming bar in the browser (first trade = open, then high, low, close), merged into
  the server's bar of that slot or added after it. Full screen is regular hours only;
  1D moves today's bar. A new bar stays in view while the newest bars are shown.
- Day chart (alert rows, market strip): the stock and benchmark lines and the numbers
  over the chart move with the newest minute (not in "Around alert").

The charts' own reads (3 s, 15 s, 30 s) are unchanged and bring volume, VWAP and scores.
Without real-time SIP (`ALPACA_SIP_DELAY_MINUTES` > 0) the route answers 409 and the
page stops asking. Cost: one Worker request and one Alpaca request per second per open
tab during the session. Validation: unit and Worker-route tests; headless Chromium with
mocked, synthetic prices on the Watchlist, candle, full-screen and day charts (one
request per second; prices, forming bars and lines moving each second).

## Full-screen chart with SPY, bar sizes, VWAP and volume (2026-10-18)

Every stock chart (alert rows on Alerts and Backtest, the market chart, Watchlist rows,
Positions and Trade) has an expand button. It opens a dark, full-window chart. The stock
is drawn on the right price axis and SPY (or the sector ETF) on the left, each in
dollars. Bar sizes are 1m (yesterday and today), 5m, 15m, 1h and 1D; drag left for older
bars. There is an optional session VWAP, off by default. Volume is compared with the
last 20 sessions: a chip, a dashed average line, and the average and percentile per bar.
A legend, a data window and a crosshair show prices on both axes. Close with ✕, Esc or
Back. Data comes from `GET /api/bars` (regular hours, split-adjusted). See the
[spec](features/fullscreen-chart.md).

## Watchlist: its own section, one line per stock (2026-10-16)

Sections are Alerts · Watchlist · Portfolio · Backtest: a bottom tab bar on phones
(≤720px), the header switcher on wider screens; `#alerts`, `#watchlist`, `#portfolio`
and `#backtest` open a section. The watchlist shows one dense row per stock (IBKR-like):
symbol, today's line (green above / red below the dashed previous close), last price
with volume, change %, and Rel vol (orange from 2×). From 760px wide it adds vs
SPY/sector, the score, the day range and alert counts. Filters: All, Moving, Rel vol ≥2×,
With alerts. A row opens the day chart, key numbers, and links to its alerts and to Trade.
The board's load time is unchanged.

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

**A trade's story (2026-10-24).** A tap on a closed trade, the owner's or the bot's, opens a window: a chart on
the regular chart's library (zoom, scroll, more days on a drag) with the stock and SPY, the volume, the bot's
strength against SPY minute by minute, the option and its volume, the entry, each exit, the signal and the level
the bot watched with its touch and fall-back lines marked, line or candles; why it was entered (the bot's signal
and rules, or the owner's buy order); why each exit happened (the bot's rule, or what the fills show); the fills.
`GET /api/trade-chart` serves the minutes. See [the task](tasks/frontend-trade-story.md).

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

## Trade tab: own limit price, debit spreads, IBKR-style expiry tabs (2026-10-18)

- One contract can be bought at the owner's own limit (Price: Auto | Limit): one day
  order at that price, a stop on every fill until it fills or the close.
- Single | Spread: tap the leg to buy, then the leg to sell (same side and expiry). The
  spread ticket shows the net mid and natural price; the check shows spreads, max loss,
  max gain and breakeven. One Alpaca multi-leg day order; no stop, sized on the debit.
  IBKR answers that it takes no multi-leg orders.
- Never-short rule amended (decisions, 2026-10-17): a short leg covered by a debit
  vertical's long leg is allowed. A spread leg is never sold, resized or stopped alone;
  the portfolio lists Spreads with a Close spread control (one order, net credit) and
  marks each leg "in a spread". Spread legs do not block buys for missing stops; open
  risk counts a spread at its net debit.
- Expiry tabs: a flat strip, "Oct 19 '26" with W on weeklies and the days left, the
  chosen one boxed, arrows to scroll.
  Validation: typecheck, 481 tests (478 pass; the IB Gateway and launcher tests fail on
  this Windows checkout as on main), build, and headless Chrome screenshots with
  synthetic data. Not yet run against Alpaca: see the
  [task](tasks/integration-option-limit-and-spreads.md).

## Trade tab: calls and puts side by side (2026-10-17)

The option chain is one IBKR-style table: Calls (Spread, Delta, Bid, Ask) | Strike | Puts
(Bid, Ask, Delta, Spread), with the stock-price line between strikes and each side's
in-the-money half shaded. A click on either side picks that contract for the ticket; the
ask is its keyboard button. The Calls/Puts switch is gone. Expiry tabs show the days left
(calendar days from today in New York). Phones (≤560px) hide Spread; a wide spread stays
amber on the ask. The page reads both sides from the unchanged chain endpoint in parallel
(two requests per 2-second refresh); a side that fails shows a notice while the other
still shows, and a side that misses one refresh keeps its last quotes.
Validation: typecheck, all chain-model tests, production build, and headless Chrome
screenshots at 1100px and 390px with synthetic mocked chain data (also with the puts
failing), plus scripted put/call clicks. Not yet checked against live Alpaca quotes.

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
