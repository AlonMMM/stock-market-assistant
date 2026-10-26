# Task: a closed trade's story (chart, why in, why out)

Status: implemented on `feat/trade-story` (PR #137); the chart rebuilt on `feat/trade-story-chart`
Owner: frontend (with the chart endpoint and the bot's entries, backend)
Branch: feat/trade-story-chart

## Outcome

User (2026-10-24): "add a graph to the history trades (both bot and mine) … and an info to explain why we entered
and why we exit (all the info can go in a special modal)." Then: "I want to be able to zoom in and out and scroll
aside like we do in regular chart"; "I would like to see resistance and holding we are using for stops when not
breaking"; "I want volume"; "visualize how the SPY strength moves and the SPY graph on the chart as well"; "regular
graph and candle as toggle"; no legend, no hint text, a bigger window.

Portfolio → History (the owner's account) and Portfolio → Bot trades (the bot's account): a tap on a closed trade
opens a window with:

- **The chart**, on the library the regular chart uses, so the wheel or a pinch zooms, a drag moves sideways, and
  dragging past the first or last day reads more days. Five panes on one minute: the stock (a line, or candles
  by a toggle that is remembered) with SPY beside it on a left scale; the stock's volume; the bot's **strength
  against SPY** minute by minute (the t-stat its signal reads, with the rule's bar on the bet's side and a faint
  one on the other); the option (line or candles); the option's volume. A stock trade has the first three panes.
  Lines, each named on its price axis: the stock's entry, the level the bot watched ("yesterday's high ·
  watched"), the **touch line** a quarter unit short of it and the **fall-back line** half a unit short ("fall-back
  · sell": a close back here within 30 minutes of a touch is the sale), what was paid, and the stop (the bot's
  −30%, or the owner's broker stop). Markers: an arrow up for the buy, an arrow down for each sale, dots for the
  signal, the touch and an expiry; their labels show when the bars are wide enough apart to read them. Dashed
  lines mark where each day starts. The crosshair readout above the chart gives the time (Israel), the stock, SPY,
  the volume, the strength and the volume ratio, and the option.
  Three views: **The trade** (20 minutes before the entry to 40 after the last exit), **Trade day** (the trade's
  days; the window opens here), **All days** (every day read so far). The window opens with two days each side
  of the trade, up to the last closed session; a drag past either end reads three more.
- **Why it was entered.** Bot trades: the signal (t and volume against the rule's numbers, as the version in
  force had them), the contract and what it cost, the level ahead, the bot version. The owner's trades: the buy
  order's command inputs, how the contract was picked, the size and the stop, the order's notes, and a **Why**
  button to the full order (every input, the chain, each check). An order no longer in the orders list says so.
- **Why it was exited.** Bot trades: each sale with its reason as the rule it came from (10-minute check,
  stop −30%, failed break with the level's name and price, day exit, overnight cap, morning gap, expiry day).
  The owner's trades: an expiry, a sale at or below the stop ("most likely the broker stop"), else "Your sale".
  The owner's sells carry no recorded reason, so no more is claimed.
- **Fills.** The table that the row used to unfold.

## Design

- `GET /api/trade-chart?symbol=<OCC or ticker>&from=<date>&to=<date>` (`packages/market-data/src/trade-chart.ts`,
  `handleTradeChart`): for the sessions from `from` to `to` (consecutive, up to seven; a longer span carries the
  last seven and says how many were left out), each session's one-minute bars of the stock
  (`[minute, o, h, l, c, v]`), SPY's closes, the **strength** (`[minute, t, volume ratio]` from minute 2, computed
  by the bot's own `cState` against the 20 sessions before that day, read in the same request) and, for an option,
  the contract's bars (Alpaca `/v1beta1/options/bars`). Regular hours only. 400 on a bad symbol, a non-session
  date, `to` before `from` or a day without data yet; 502 when Alpaca fails. Served by the Worker and the local API
  with the market-data credentials; nothing cached.
- `GET /v1/bot` / `/api/bot`: `positions[].breakWatch.unit` (the stock's unit in dollars, kept by the trader since
  the failed-break sale) is now typed, for the touch and fall-back lines. `entries` as before.
- `apps/web/src/trade-story-model.ts`: `chartWindow` (the days to open on), `lastClosedSession`, `barTime` (the
  Israel wall clock read as UTC, like every chart here), `mergeSessions`, `levelLines` (the lines a story draws),
  `botStory` / `ownerStory` / `unknownStory` as before, now with the bet's side and the rule's t.
  `apps/web/src/TradeStoryChart.tsx`: the chart (lightweight-charts, five panes, price lines, markers, the views,
  the edge loading). `apps/web/src/TradeStory.tsx`: the window, the view and line/candles toggles, the readout, the
  sections. `packages/market-data/src/calendar.ts`: `nextSessions`.
- The window is 1240 px wide on a desktop; on a phone (≤ 640 px) a full-screen sheet with a shorter chart.

## The entry and the exit at a glance (2026-10-26)

User: "we are not showing the real enter and exit. Also it very not ux fun… make it easy to a human to analyze the
enter and exit" (a CRWV 66 call bought and sold the same morning, viewed during that session).

- **Bug fixed:** the window stopped at the last _closed_ session, so a trade viewed during its own session drew the
  days before it, and its markers fell on an older day's last bar. The window now runs to the latest session that has
  opened (`lastOpenSession`); the trade's own days are always drawn (the API serves today's minutes up to now).
- **The fills drawn at their own minutes:** a vertical line at the buy and at each sale through every pane, a tag
  along the top ("Buy 16:53", "Sell 18:47"), a dot at each fill's price on the option pane, and the time held shaded.
  They no longer ride the option's series markers, which a thin contract lacks in many minutes.
- **A summary above the chart** (`tradeStats`): the entry (time, contracts, price, the stock), each exit (time,
  price, % from what was paid, the rule), the time held and the result, the stock's and SPY's move over the trade,
  the option's best and worst while held, and its highest and last price after the sale that day.
- **The view opens on "The trade"** (30 minutes before the entry to 60 after the exit). The watched level's touch
  and fall-back lines show only when the exit was a failed break; otherwise a far level no longer stretches the
  price scale.

## Verification evidence

- `tests/trade-chart.test.ts`: the stock, SPY, the strength and the contract by session minute (regular hours
  only), the reads made (the stock and SPY from 20 sessions before), a stock trade, a hold across sessions, the
  seven-session cut, the request checks (synthetic Alpaca answers).
- `tests/trade-story-model.test.ts`: the trade's sessions, the days the window opens on and the last closed
  session, the chart's times, merging answers, a bot trade's story (signal, contract, level, each sale's rule,
  the stop, markers and their labels, the level's touch and fall-back lines for a call and a put), the owner's
  story.
- `npm run typecheck`, `npm test`, `npm run build`: see the PR.
- Looked at in Chrome against a synthetic API (1440 px and 390 px): the three views, line and candles, the
  readout, older days loading on a drag; see the PR.

## Deploy

The website Worker (the chart endpoint and the window) and the trading service (`unit` in the bot status).
