# Task: Approximate portfolio model, trade filters and trade journal data

Status: completed (backend); frontend follow-up proposed
Owner: backend
Branch: fix/approx-portfolio-model

## Outcome

1. The Approx. now portfolio view values options with a model that stays sane
   for large moves and short expiries, against the right underlying reference.
2. Orders and History can be filtered by Israel date range, ticker and win/loss.
3. A buy command can be shown together with the trade it opened, as the data
   for a trade-oriented detail page.

## Review of the previous approximation (findings)

- **Wrong reference overnight.** The option mark was compared with a daily
  close chosen by date. Between 20:00 and 04:00 New York, the BOATS snapshot's
  daily bar came first; it ends with overnight trading, so the "move" since
  the mark was mostly hidden and the estimate barely changed.
- **Close ≠ mark time.** Option marks are set at 16:00 (16:15 for index ETFs)
  or earlier for illiquid contracts; a daily close is the wrong underlying
  price for them.
- **Taylor expansion breaks on big moves.** delta·ΔS + ½·gamma·ΔS² grows
  without bound: a 720 call marked 2.10 with the stock at 690 came out at
  about 93 after a +70 move (it is worth about 41).
- **Linear theta.** theta × days could take more than the remaining time value
  and ignored the option converging to intrinsic value near expiry.
- **Stock snapshots never parsed** (found on live data, see below).
- **Wide extended-hours quotes.** A quote mid was used for the stock however
  wide the spread.

## What changed

- `packages/trading/src/option-estimate.ts`: Black-Scholes repricing. IV is
  implied from the last mark at the underlying price of that moment, then the
  option is repriced at the latest underlying price and the remaining time to
  the expiry close (16:00 New York; 13:00 on early closes). Result is floored at
  intrinsic value. Without any IV, a Greeks expansion with theta capped at the
  remaining time value. Assumed risk-free rate 4%.
- `portfolio.ts`: the reference is the underlying's one-minute bar ending at
  the option mark's time (grouped by hour: normally one extra request, at most
  three), falling back to the regular-feed close of that New York day, never
  the BOATS bar. A mark under two minutes old uses the live price. Stock quote
  mids are used only when the spread is at most 1%.
- Contract change, `PortfolioPosition.estimateBreakdown`: now `model`,
  `optionMark`, `underlyingReference`, `underlyingReferenceSource`
  (`live` | `minute` | `close`), `underlyingMove`, `moveEffect`,
  `timeEffect`, `volatility`, `elapsedDays`. The Δ/Γ/Θ/vega effect fields are
  gone; `Positions.tsx` was adapted minimally.
- `packages/trading/src/trade-journal.ts`: `filterTrades`, `journal` (links a
  filled buy to the closed trade of the same contract), `filterJournal`,
  `journalTickers`. Dates are Israel dates; History is dated by the close,
  Orders by the command. Breakeven is neither win nor loss; filled buys still
  held are `open`.

## Frontend follow-up (proposal, not built)

Filters (Orders and History share one bar): date presets (Today, 7D, 30D,
custom from/to), ticker chips from `journalTickers`, All / Win / Loss
segmented control. Keep the filter in the URL query so a view can be shared.
Show filtered count and realized P&L for the filtered set.

Trade page, `#/trade/<decision id>` instead of the current dialog:

1. Header: contract, result badge (Win/Loss/Open), P&L $ and %, held time.
2. Timeline: command → fill (price, qty) → stop set/moved → exit or expiry,
   each with Israel time.
3. Numbers grid: entry, exit, qty, cost, stop % and risk, delta at entry.
4. "Why" section collapsed by default: checks and sizing from the explanation.
5. Underlying day chart with entry and exit marks (reuse `DayChart`).

## Verification evidence

- `npm run check`: format, typecheck, 411 tests pass, build succeeds.
- New: `tests/option-estimate.test.ts` (textbook Black-Scholes values, IV
  round-trip, expiry times, bounded big moves, decay to intrinsic, Greeks
  fallback), `tests/trade-journal.test.ts`, and a BOATS-reference regression
  in `tests/portfolio.test.ts`.
- Verified against Alpaca (paper account, read-only) on 2026-10-14 07:22 New
  York, pre-market: all 3 option positions priced with the `minute`
  reference (USO 0.49 → 0.56, ORCL 0.67 → 0.34, INTC expiring today → 0).
- That run found a pre-existing bug: Alpaca's multi-symbol stock snapshot
  response has symbols at the top level (no `snapshots` key), and names the
  fields `minuteBar` and `impliedVolatility`. The site read none of them, so
  pre-market and after-hours estimates never had a stock price. Both shapes
  are now read; covered by a test.

## Limitations and better approaches

- IV is held at the last mark's level; overnight IV changes (earnings, gaps)
  are unknown. On event days the estimate is less reliable.
- Calendar-time decay over weekends overstates decay compared with how
  options reopen on Monday; trading-time decay is an alternative to evaluate.
- Better than any model: when Alpaca publishes overnight option quotes for a
  contract, use them directly; and store each estimate with the next open's
  mark to measure the model's error.
