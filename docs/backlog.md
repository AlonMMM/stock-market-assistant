# Backlog

Updated: 2026-10-26

What is next for the Stock Market Assistant. This file is the source of truth; the board at
https://claude.ai/artifact/VzgHGHzP5SYWhVefpvTmRH shows the same items with lanes, filters and search. How every
session keeps both live: [AGENTS.md, Backlog](../AGENTS.md#backlog).

Lanes, in order of urgency: **Now** (being worked on), **Next** (up after that), **Later** (when there is room),
**Done** (the latest 10 finished items). Within a lane, the first item comes first.

## Item format

One `###` heading per item under its lane, then its fields as `- key: value` lines, a blank line and the notes:

- `id`: unique, lowercase words joined by dashes; never reused.
- `area`: one of Bots, Research, App, Alerts, Ops.
- `tags`: topics to filter by, comma-separated (for example Main bot, Volume bot, Performance, Watchlist,
  Overnight, Charts, Backtest, Deploy, Telegram, Docs).
- `waiting` (optional): what the item is blocked on: a person, a key, a decision, another item.
- `source`: where it came from (a PR, a doc, a session).
- `done` (Done lane only): the date and the PR that finished it.

`npm run backlog` checks the file and prints the items as JSON for the board. The board's page is
[backlog-board.html](backlog-board.html): republish it to the same URL with the Artifact tool (`url`) after a change;
its items live in the page's store (`items/<id>`), written from that JSON.

The detailed acceptance criteria of the older items are in [the October 15 product backlog](product-backlog.md).

## Now

### Deploy the October 26 merges

- id: deploy-oct26
- area: Ops
- tags: Deploy, Site
- waiting: A deploy from your Mac (cloud sessions have no Cloudflare access)
- source: Session of Oct 26

PRs #160 to #171 merged on Oct 26: overnight prices, the IBKR-style watchlist and dark mode, risk pages per
account, Volume bot changes, read-only for visitors. Deploy the site from a clean main with `npm run deploy`, and
redeploy the trading service on Railway where its code changed. Done when the live site shows the moon prices at
night and the Risk pages load.

### Check overnight prices on the live site

- id: night-prices-live
- area: App
- tags: Watchlist, Overnight
- waiting: The deploy
- source: PR #160

After the deploy, open the watchlist between 20:00 and 04:00 New York (02:00 to 10:00 Israel time until New York
changes its clocks on Nov 1, then 03:00 to 11:00) and confirm night prices show with a moon. If every row shows C,
Alpaca refused the BOATS request and the endpoint fell back to SIP.

### Check the trade page and the account chart on real trades

- id: trade-page-live
- area: App
- tags: Main bot, Portfolio, Charts
- waiting: The deploy
- source: Session of Oct 26

After the deploy, open the CRWV 66 call of Oct 26 (Portfolio → Bot → Trades): the chart should show Oct 26 with
"Buy 16:53" and "Sell 18:47" at their minutes, the time held shaded, and the summary above it. Check the account
chart's day labels and steps. Built and checked on synthetic data only; no live data was reachable from the session.

### Compare the Main bot's paper trades with the backtest

- id: main-bot-vs-backtest
- area: Bots
- tags: Main bot, Performance, Backtest
- source: Research log; session of Oct 25

For each live entry, replay the same day with the bot-backtest skill: same signal minute, contract and exits
expected. Log every difference with its cause (contract picker, fills, settings, data). This is the only clean
test left; the rules were chosen on 2024 to Oct 2026 data.

### Explain the CRWD trade of October 23

- id: crwd-oct23
- area: Bots
- tags: Main bot, Backtest
- waiting: The entry line from the Bot tab (time, contract, signal note)
- source: Session of Oct 25

The live bot bought CRWD on Oct 23, but none of the 21 backtest lists has it. CRWD is the backtest's thinnest
name: 30 of 37 signals in the favorites year were rejected as illiquid. Most likely the live picker chose another
strike than the backtest's (broker delta and quotes vs delta from the last option bar), or a setting differs.

### Start the Volume bot: dry run, then paper

- id: volume-bot-start
- area: Bots
- tags: Volume bot
- waiting: The account's keys (STRANGLE_ALPACA_API_KEY) on the trading service
- source: docs/state.md, Volume bot task

The bot is merged and starts off and in dry run. Add the paper account's keys, run a week in dry run and compare
its decisions with the backtest (parity was 497 of 499), then switch to paper.

## Next

### Fill the Volume bot's benchmark band

- id: volume-bot-benchmark
- area: Bots
- tags: Volume bot, Performance
- source: PR #167

`config/volume-bot-benchmark.json` is still a placeholder of zeros, so the Benchmark page compares live P&L with
nothing. Fill it from the backtest: expected P&L by day with a band.

### Add time under water to the research reports

- id: time-under-water
- area: Research
- tags: Backtest, Performance
- source: Session of Oct 25

The longest stretch from an equity high to the next one, in trades and in sessions; the current stretch, shown
apart; and the average drawdown (pain index). Add it to the account function the reports share and to the
Backtest Reports page. Then decide whether "what counts as better" should require no longer worst stretch.

### Prove the live alert pipeline end to end

- id: alert-pipeline
- area: Alerts
- tags: Collector, Telegram
- source: docs/product-backlog.md, P0 item 1

Confirm the collector's feed and symbol count, reconnects and restarts, duplicate suppression and the 120-minute
cooldown on production data. Follow one real alert from Alpaca through storage, analysis and Telegram back to the
right alert on the site.

### Measure alert quality on a held-out period

- id: alert-quality
- area: Alerts
- tags: Alert quality, Performance
- source: docs/product-backlog.md, P0 item 2

Confirm production runs the approved 4× thresholds and 120-minute cooldown. Count alerts and their follow-through
by session (pre-market, regular, after-hours). Measurement only: no new filter without approval.

### Check that backtest alerts match live alerts

- id: live-backtest-parity
- area: Alerts
- tags: Backtest
- source: docs/product-backlog.md, P0 item 3

Rebuild alerts from SIP bars for a few symbols and compare with stored live alerts on overlapping days. Make
missing sessions and feed differences visible; confirm a cached run equals a cold run within the Worker's limits.

### Overnight candles on the charts

- id: night-candles
- area: App
- tags: Charts, Overnight
- source: PR #160, not included

The stock page candles, the full-screen chart and the day chart still end at 20:00 because they read SIP bars.
Fetch BOATS minute bars for 20:00 to 04:00 New York and draw them as a night session.

### Refresh the state doc and the task statuses

- id: refresh-docs
- area: Ops
- tags: Docs
- source: Repo review, Oct 26

`docs/state.md` mixes current notes with September ones and still calls merged branches "not merged". Many task
files show stale statuses (for example, Indi bot work "on feat/indi-bot"). Bring them up to date.

## Later

### Dark mode for the rest of the app

- id: dark-mode-rest
- area: App
- tags: Dark mode
- source: PR #160, not included

Dark mode covers the watchlist list only. Extend it to a stock's page, the price alerts page, Alerts, Portfolio
and Backtest, with the same switch.

### Deploy automatically from main

- id: auto-deploy
- area: Ops
- tags: Deploy
- waiting: Your decision, and a Cloudflare token in GitHub secrets
- source: Session of Oct 26

A GitHub Action that deploys the Worker after CI passes on main would remove the manual step. The alternative is
to let cloud sessions deploy: allow api.cloudflare.com and add `CLOUDFLARE_API_TOKEN` in the environment settings.

### Forward-test the two steady 0DTE clusters

- id: zero-dte-forward
- area: Research
- tags: 0DTE, Performance
- source: docs/research/best-algorithms.md (research/indi-v2)

Log them in the paper bot's log, not as rules: (1) yesterday's high/low breakout, thirds at +50% and +100% with a
30% trail, delta 0.45; (2) a new day-high breakout on the favorites, the −40% stop only, delta 0.20 to 0.30. Both
are small and rest on few trades.

### Write up Indi's 0DTE study

- id: indi-0dte-writeup
- area: Research
- tags: Indi, 0DTE
- source: Session of Oct 24

The analysis of his 256 same-day trades without SPX lives only in chat: mostly the nearest expiry on expiry day,
half size, closer strikes, out within 20 minutes; Mon to Wed big names in 2026 win, Fridays lose; two news trades
carry the total. Add it to `docs/tasks/research-indi-summary.md`.

### Log the fade cut on carried days

- id: fade-cut
- area: Research
- tags: Main bot, Performance
- source: docs/research/best-algorithms.md (research/indi-v2)

Candidate from the research log: from 10:00 on a carried day, sell the rest when strength vs SPY drops under 0.5
and volume is under normal. It helped only 4 trades and was picked from 5 variants, so log it in the paper bot,
don't make it a rule.

### Compare Alpaca and IBKR fills in Both mode

- id: alpaca-vs-ibkr
- area: Bots
- tags: Main bot, IBKR, Performance
- source: PRs #142, #150

After 20 or more trades in Both mode, compare each fill with the bid and ask kept on every record since Oct 25,
and the fees per broker. Decide which broker the Main bot should use.

### Decide whether to unmute the volume alerts

- id: unmute-alerts
- area: Alerts
- tags: Telegram
- waiting: Your decision
- source: docs/state.md

The volume alerts were muted in Telegram on Oct 26 when the Volume bot took over their chat. They still show in
the app.

### Show Telegram delivery state for each alert

- id: delivery-state
- area: Alerts
- tags: Telegram
- source: docs/product-backlog.md, P1 item 6

Show pending, sent, failed or expired for recent alerts, with a short failure reason and a retry only where it
cannot send a duplicate.

### Add the IV change to overnight option estimates

- id: vega-estimate
- area: App
- tags: Portfolio, Overnight
- source: docs/product-backlog.md, P1 item 4

Add vega × change in implied volatility only when both are known; otherwise label the estimate partial instead of
assuming no change. Tests for up, down and unknown.

### Check what is left of the order lifecycle test

- id: order-lifecycle
- area: Bots
- tags: Main bot, Volume bot, Orders
- source: docs/product-backlog.md, P1 item 5

The plan was to watch partial fills, stops, cancels and sales in market hours and confirm a position never goes
short. The bots now exercise much of this every day; check their records and test only what they don't cover.

### Price alerts through the night

- id: price-alerts-night
- area: App
- tags: Overnight, Price alerts
- source: PR #160, not included

Price alerts check SIP prices before and after hours, but not overnight prints from 20:00 to 04:00 New York.

### Measure readiness for about 500 symbols

- id: symbols-500
- area: Alerts
- tags: Collector
- source: docs/product-backlog.md, P2 item 7

Benchmark the collector, Alpaca limits, storage and Cloudflare request budgets at growing watchlist sizes, then
show the cost and reliability trade-offs before changing production.

### Choose the next alert family

- id: next-alert-family
- area: Alerts
- tags: New signal
- waiting: Your choice of family and formula
- source: docs/product-backlog.md, P2 item 8

Candidates from the original brief: breakouts and new highs or lows, momentum, pullbacks. Implementation starts
only after you approve the exact formula, timeframe, thresholds and cooldown.

### Split the web bundle for faster phone loads

- id: bundle-split
- area: Ops
- tags: Site, Speed
- source: npm run build warning

The build warns that a chunk is over 500 KB. Load Backtest, Portfolio and the bot pages on demand so the
watchlist opens faster on a phone.

## Done

### Trade page shows the real entry and exit; a cleaner account chart

- id: done-trade-page
- area: App
- tags: Main bot, Portfolio, Charts
- source: Session of Oct 26
- done: 2026-10-26, PR #175

The trade's own day is drawn even during its session; fills are drawn at their minutes with the time held shaded; a
summary gives the entry, exits, time held, best and worst while held and the option after the sale. The account
chart is a step line with precise axis labels and day ticks that survive Israel's clock change.

### The backlog in the repo, kept live by every session

- id: done-backlog
- area: Ops
- tags: Docs
- source: Session of Oct 26
- done: 2026-10-26, PR #172

This file, the board's search and tags, and the Backlog rules in AGENTS.md.

### Watchlist: overnight prices, IBKR's look and dark mode

- id: done-watchlist
- area: App
- tags: Watchlist, Overnight, Dark mode
- source: Session of Oct 26
- done: 2026-10-26, PRs #160, #161, #166

Night prices from BOATS with a moon and change from the close, IBKR's columns and number font, dark mode with a
switch; followed by aligned phone columns and IBKR's number size.

### Risk settings per account

- id: done-risk
- area: Bots
- tags: Risk, Main bot, Volume bot
- source: docs/state.md
- done: 2026-10-26, PRs #154, #159, #163

Each account has its own loss limits and brake on a Risk page in each bot's tab; a trade's risk is counted at
its stop.

### Read-only for everyone but the owner

- id: done-readonly
- area: App
- tags: Site
- source: docs/state.md
- done: 2026-10-26, PR #164

Visitors can look but not trade or change settings anywhere in the app.
