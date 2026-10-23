# Task: 10-second bar database for research

Status: active
Owner: backend
Branch: feat/bars-10s
Spec/contract revision: none (user request, 2026-10-23)

## Outcome

A local SQLite database of 10-second bars, regular hours only, for every symbol on the
research list (`data/local/backtest-tickers.txt`, 196 tickers), one year back, built from
Alpaca SIP trades. Research scripts (Python or TypeScript) read it directly.

## Scope and exclusions

- `scripts/build-10s-bars.ts` (`npm run bars:10s`): fetches every trade of each
  symbol-day with `GET /v2/stocks/{symbol}/trades` (SIP, 10,000 per page), aggregates
  them into 10-second bars with Alpaca's own condition rules, and stores them. Resumable
  and rerunnable: finished symbol-days are recorded and skipped.
- `scripts/check-10s-bars.ts` (`npm run bars:10s:check SYMBOL DATE`): rolls one
  symbol-day up to minutes and compares with Alpaca's minute bars.
- `packages/market-data/src/trade-bars.ts`: the aggregation (`TradeBarBuilder`,
  `tradeRole`, `rollUp`), unit-tested. `AlpacaFeed.trades()` pages through trades.
- Regular hours (09:30 to the core close, early closes honored). Extended hours are not
  built. No Worker, API or UI change. Databento or other vendors are not wired in; the
  database format does not depend on the source.

## Data

`data/local/bars-10s.sqlite` (ignored by Git):

- `bars(symbol, start, open, high, low, close, volume, trades, vwap)`, primary key
  `(symbol, start)`. `start` is the bar's start in Unix seconds, a multiple of 10. Prices
  are raw dollars (not split-adjusted), `volume` is shares, `trades` the number of
  volume-counted trades, `vwap` the volume-weighted price of those trades.
- `symbol_days(symbol, date, trades, bars, built_at)`: every finished symbol-day, with
  the number of trades fetched and bars written (zero-trade days included, so they are
  not fetched again).
- `meta`: `bar_seconds`, `feed`, `hours`, `rules`, `source`.

Aggregation rules (Alpaca market-data FAQ, "How are bars aggregated?", 2026-10-23):
a trade's condition codes decide whether it sets prices, counts volume, or neither.
Odd lots (`I`), average-price prints (`B` on tapes A/B, `W` on tape C), cash sales,
prior-reference prints, out-of-sequence prints etc. count for volume only; official open
and close prints (`M`, `Q`) and corrected closes (`9`) count for nothing; canceled prints
and prints superseded by a correction are skipped. A slot with no priced trade produces
no bar, so its volume is not in the database (see Limitations).

## Acceptance criteria

- A minute rolled up from the 10-second bars has Alpaca's open, high, low and close for
  every regular-hours minute of a symbol-day, and the same volume except for minutes
  containing a 10-second slot with only unpriced trades.
- Rerunning the script fetches only symbol-days not yet recorded; a stopped run resumes.
- A symbol-day that fails after retries is reported and left for the next run; the
  exit code is 1.
- Requests are paced to `--rate` per minute, with 429 and 5xx answers retried.

## Plan and assumptions

- Decided with the user (2026-10-23): source Alpaca trades (the account has real-time
  SIP), one year, regular hours only, Alpaca first with the format kept source-neutral.
- Assumption: one row per bar in SQLite rather than one blob per symbol-day, so plain
  SQL (and pandas) can query and re-aggregate without decoding. About 75 bytes per bar
  on disk: a year of 196 symbols is roughly 115 million bars, about 8–9 GB.
- Assumption: Alpaca's `u` correction marker is honored (canceled and superseded prints
  dropped); Alpaca's own minute bars appear to keep them (they were built live), which
  is another possible source of tiny volume differences.

## Verification evidence

- `node --import tsx --test tests/trade-bars.test.ts tests/alpaca.test.ts`: 10 pass
  (condition rules per tape, bucket alignment, out-of-order trades, window trimming,
  unpriced slots, roll-up; trades pagination and null pages).
- `npm test`: 595 pass, 0 fail. `npx tsc -p tsconfig.json`: clean.
- Trial against Alpaca (real SIP data, 2026-10-23): AAPL and F for 2026-10-21 and
  2026-10-22 into a scratch database: 1,519,759 trades → 9,302 bars, 154 requests, 36 s
  at 600 requests/min. Check: AAPL 2026-10-22, 390 of 390 minutes with identical OHLC,
  389 identical volume, 1 minute 2 shares short; F 2026-10-21, 390/390 OHLC identical,
  13 minutes with slightly less volume (0.1–6% of the minute), all explained by 10-second
  slots that held only odd lots or average-price prints (verified by refetching one such
  minute: the trade list sums to Alpaca's volume, and the missing shares are in slots
  with no priced trade).
- Full one-year build: not yet run at the time of writing; see Handoff.

## Limitations

- Volume: a 10-second slot with only unpriced trades is absent, so summing the day's
  bars gives slightly less than Alpaca's daily volume (F: 13 of 390 minutes affected,
  under 1% of the day). Research that needs exact volume per minute should use the
  minute-bar stores.
- Cost of a full year: Alpaca pages 10,000 trades per request; a liquid stock prints
  0.5–1.5 million trades a day. The 196-symbol year is on the order of 700,000 requests
  and roughly 100 GB of compressed transfer. At `--rate 2000` that is about 6 hours.
- Prices are raw. Symbols with a split inside the range need adjusting at read time.

## Handoff

Run the full build from the repository root (resumable, safe to stop and rerun):

```
npm run bars:10s -- --rate 2000 --parallel 6
```

Then spot-check a few symbol-days with `npm run bars:10s:check NVDA 2026-10-21`.
A daily rerun of the same command appends the latest finished session.
