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
