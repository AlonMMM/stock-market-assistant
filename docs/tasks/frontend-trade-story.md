# Task: a closed trade's story (chart, why in, why out)

Status: implemented on `feat/trade-story`
Owner: frontend (with the chart endpoint and the bot's entries, backend)
Branch: feat/trade-story

## Outcome

User (2026-10-24): "add a graph to the history trades (both bot and mine) … and an info to explain why we entered
and why we exit (all the info can go in a special modal)."

Portfolio → History (the owner's account) and Portfolio → Bot trades (the bot's account): a tap on a closed trade
opens a window with:

- **The chart.** Two panes through the sessions the trade spanned: the stock each minute, and the option each
  minute it traded. Marked on them: the buy ("bought 2 at 0.40"), each sale, the bot's signal minute and the
  minute the stock tested the level it watched. Lines: the stock's entry price, the bot's level ("day high so
  far $74.40"), what was paid, and the stop (the bot's −30%, or the owner's broker stop). A crosshair on hover
  or touch shows the time (Israel), the stock and the option. Sessions sit side by side with a gap; a hold of
  more than five sessions shows the first and the last four and says how many were left out.
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
  `handleTradeChart`): the stock's regular-hours one-minute closes and the contract's (Alpaca
  `/v1beta1/options/bars`) for the sessions from `from` to `to`, as `[minute since 09:30, close]` pairs per
  session. Up to five sessions (`chartSessions`); more show the first and the last four. 400 on a bad symbol, a
  non-session date, `to` before `from` or a day without data yet; 502 when Alpaca fails. Served by the Worker and
  the local API with the market-data credentials; nothing cached.
- `GET /v1/bot` / `/api/bot` adds `entries`: the signals that entered a position in the last five sessions (the
  same window as `positions`), so a closed bot trade's t and volume are there after the day. `BotView.positions`
  now types `entryStock`, `entryMinute` and `sales[].price`, which the store already kept.
- `apps/web/src/trade-story-model.ts`: `tradeDates`, `chartAxis` (sessions side by side), `botStory` (from the
  bot's position, its signal and sales; the rules of the position's version when known exactly, else the
  settings now), `ownerStory` (from the buy decision matched by contract and time, and the fills),
  `unknownStory` (a bot trade older than the bot's records). `apps/web/src/TradeStory.tsx`: the window and the
  SVG chart. `apps/web/src/format.ts` and `use-width.ts`: helpers shared with the Portfolio and the P&L chart.
- On a phone (≤ 640 px) the window is a full-screen sheet; the chart's panes are shorter and the time ticks hourly.

## Verification evidence

- `tests/trade-chart.test.ts`: the stock and the contract by session minute (regular hours only, the contract's
  traded minutes), a stock trade, a hold across sessions, the five-session cut, and the request checks
  (synthetic Alpaca answers).
- `tests/trade-story-model.test.ts`: the sessions and the request, the x axis, a bot trade's story (signal,
  contract, level, each sale's rule, the stop and markers; another version's numbers; no record), the owner's
  story (the order matched by contract and time, each line, the stop heuristics, an expiry).
- `npm run typecheck`, `npm test`, `npm run build`: see the PR.
- Looked at in Chrome against a synthetic API (desktop and 390 px): see the PR.

## Deploy

The website Worker (the chart endpoint and the window) and the trading service (`entries` in the bot status);
until the trader is deployed, a bot trade's signal numbers are missing after its day.
