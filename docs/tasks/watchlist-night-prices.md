# Task: Overnight prices and the IBKR-style watchlist

Status: completed (not deployed)
Owner: integration (unattended session; touches the price API and the watchlist UI)
Branch: claude/zero-dte-experiment-review-u1auv1
Spec/contract revision: user requests of 2026-10-26 ("why we can't see night prices in our app", "Build it. Use
this for the watchlist design. See the numbers font", with a screenshot of IBKR's mobile watchlist)

## Outcome

Between 20:00 and 04:00 New York the Watchlist and the stock page show the overnight session's prices (Blue Ocean,
Alpaca's BOATS feed, included in the account's Algo Trader Plus plan). The Watchlist table reads like IBKR's.

## What changed

- **`GET /api/prices`** (`packages/market-data/src/latest-prices.ts`): in the overnight session it asks Alpaca for
  `feed=boats` and adds `overnight: { date, since }` to the answer. If BOATS is refused, SIP answers as before.
  `packages/market-data/src/overnight.ts` defines the session: 20:00–04:00 New York on the night before each US
  trading day (Sunday night to Friday morning; none before a holiday).
- **Watchlist model** (`apps/web/src/live-model.ts`): the page keeps reading prices every second through the
  night. A print after 20:00 is not added to the day's line; the row shows it with a moon, and Chng and Chg % are
  measured from the day's regular close (the close of the last 5-minute bar before 16:00, within cents of the
  official closing print). A row without a night print, a closed market (weekend, holiday) and a stock not yet
  traded in the pre-market show "C" and the close, IBKR's mark. Overnight, a row without a night print shows no
  change.
- **Stock page header**: the night price and its change vs the close, "Night · vs close · <time>".
- **Table design** (IBKR screenshot): on phones five columns, Instrument (symbol with the sector ETF beside it),
  Last price, Chng, Chg %, Volume. Numbers in Roboto (Android's system face, IBKR's), regular weight, tabular
  figures, as large as the symbol; plain green and red instead of tinted pills; "+0.53", "-1.63", "0.07%",
  "-0.23%", volume to three digits ("41.2K", "151K"); a cell flashes yellow for a moment when its value changes.
  From 760px the other columns stay: Today, vs SPY/sector, Score, Rel vol, Day range, Alerts.
- **Rel vol on phones**: the Today and Rel vol columns left the phone layout to fit IBKR's five; Volume turns
  orange at 2× usual volume or more (the Rel vol threshold) and its tooltip gives the ratio.

## Not done

- Charts (candles on the stock page, full screen, day chart, market cards) still end at 20:00: they read SIP bars.
  Overnight candles need BOATS minute bars in `/api/candles` and a "night" session in the charts.
- Price alerts and the board's volume numbers stay on SIP (regular and extended hours).
- The app's light theme is kept; the table is not switched to IBKR's dark look.

## Verification evidence

- `npm run check`: formatting, types, 661 tests (660 pass, 0 fail, 1 skipped as before), build.
- New tests in `tests/latest-prices.test.ts`: the overnight session's bounds (Sunday night, 04:00, 20:00, Friday
  night, the eve of Thanksgiving), BOATS at night and the SIP fallback, night rows, "C" rows, weekend rows, the
  pre-market before a first print, IBKR's number formats.
- Headless Chromium on the dev server with mocked, synthetic board and prices, the browser clock pinned to 21:30
  New York on a Monday and to a Saturday, at 412px and 1180px: moon prices with change vs the close, "C" rows
  without change, the yellow flash on changed cells, the weekend's "C" closes with the day's change.
- Not verified: real BOATS answers through the deployed Worker (no Alpaca keys in the session); Roboto itself
  (the headless browser has no Roboto, so it drew a fallback face).
