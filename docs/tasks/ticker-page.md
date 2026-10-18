# Task: A stock's own page from the watchlist

Status: completed (in review)
Branch: feat/ticker-page

## Outcome

User request (2026-10-18): "when clicking on a ticker from the watchlist, open the ticker
with extra data in its own page, something like IBKR: the graph as we show it today, go
to option/stock/trade, general info about this ticker, etc."

A watchlist row now opens `#watchlist/<TICKER>` (Back returns to the list):

- Name, exchange and sector ETF; last price, change, bid × ask and the last trade's time.
- Options, Shares (owner only: the trade ticket opens on that stock's options or shares)
  and Alerts (today's count).
- Today's 1-minute candle chart, as in the watchlist, with its full-screen button.
- Today: open, previous close, volume, 30-day average volume, Rel vol, VWAP, beta, score
  vs SPY, the day's range and the 52-week range with the price marked.
- Performance vs SPY: a one-year line of closes, and 1W/1M/3M/6M/YTD/1Y returns of the
  stock and SPY.
- Your position: what is held of it (shares and options, entry, stop, P&L) and its open
  orders, from the portfolio.
- Today's alerts, the latest 8 news headlines (opened in a new tab; https links only),
  and About (name, exchange, options listed, tradable).

## Contract

`GET /api/ticker?ticker=NVDA` (Worker and local server):
`{ ticker, asset, quote, stats, news }` from Alpaca: the stock's snapshot, one year of
daily bars of it and SPY, the trading API's asset record (paper or live, by
`ALPACA_TRADING_LIVE`), and `/v1beta1/news`. A part that fails is `null` (or no news);
502 only when snapshot, bars and asset all fail. Refreshed every 15 s on the page.

Not available from Alpaca: market cap, P/E, earnings dates; not shown.

## Verification evidence

- `npm run typecheck`, `npm test` (516: 515 pass, 1 skipped), `npm run build`,
  Prettier on every changed file.
- `tests/ticker.test.ts`: the year's range, average volume and returns vs SPY with and
  without enough history; the endpoint with a fake Alpaca, a failed part left out, only
  https news links, a bad ticker refused.
- Local server with real Alpaca data (NVDA), headless Chromium at 390 and 1280 px on a
  temporary local list (deleted): the page, `#watchlist/NVDA`, and Back to the list; no
  page errors.

## Addition: the user's own price alerts (user 2026-10-18)

"Regardless of the alerts we built, on a specific stock the user can ask for an alert
above a price or a % move, then get alerts on the mobile."

- On a stock's page, **Price alerts**: price above / below a level, or up / down today by
  a % (from the previous close), with an optional note. Listed with Delete; a fired one
  shows when and at what price, with Arm again. A level already passed fires at the next
  check, and the card says so.
- `packages/market-data/src/price-alerts.ts`, D1 table `price_alerts`.
  `GET/POST /api/price-alerts[?ticker=]`, `DELETE /api/price-alerts/<id>`,
  `POST /api/price-alerts/<id>/rearm`. At most 100 armed.
- The Worker's minute cron reads all armed stocks' last trades in one Alpaca
  `/v2/stocks/snapshots` request (pre/after-hours included) and sends each alert that is
  met to Telegram once, then marks it fired; one that could not be sent stays armed.
  Telegram: `PRICE_ALERTS_TELEGRAM_BOT_TOKEN` / `_CHAT_ID` Worker secrets, else the trades
  channel's. Optional `SITE_URL` var: a link to the stock's page in the message.
- Locally the alerts are stored but not sent (no cron).
- Evidence: `tests/price-alerts.test.ts` (CRUD and refusals, sent once, failed send kept
  armed, re-arm, % kinds, the message, one snapshots request, the hosted route); the card
  on the local server at 390 and 1280 px. Not yet seen end to end: a message from the
  deployed cron.

## Revision: price alerts on their own (user 2026-10-18)

"The alert looks very bad; it should not be related to the volume alert system, it
should be separate and by price / % move configured by the user."

- A stock's page: **Price alert** (bell) opens a sheet: the price now, Price level (a big
  field, ±1/2/5% chips, ▲ above / ▼ below set from the level) or % move today (▲ Up /
  ▼ Down, 1–10% chips), a note, and a sentence saying exactly when it fires. The volume
  alerts' button is now **Volume alerts**. The stock's own price alerts are listed under
  the buttons.
- **Price alerts** page (`#watchlist/alerts`, the bell in the Watchlist title): every
  price alert, armed and fired, each with its stock, rule, note, Arm again and Delete.
- Telegram: "🔔 $NVDA crossed above $220.00", the price now and today's move, the note,
  a link when `SITE_URL` is set, and "Your price alert · sent once".
- Checked at 390 and 1280 px on the local server (test alerts deleted).
