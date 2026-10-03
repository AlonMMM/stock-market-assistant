# Feature: Options strategy backtest

Status: proposed — discovery; the strategy is not defined yet
Owner: product-ux
Spec revision: pending user agreement

## User and outcome

The user wants to test an options trading strategy. Product scope already separates alert
replay from a profitability backtest: a P&L test also needs entry, exit, contract
selection, costs and fill assumptions. This feature adds that test, driven by the user's
own rules, on Alpaca historical options data.

Observable result: the user defines a strategy, runs it over a date range, and sees every
hypothetical trade plus summary statistics, clearly labelled as hypothetical, with a
comparison against a naive baseline.

## Scope and exclusions

In scope for v1: one strategy at a time; long single-leg calls/puts and, if wanted,
vertical spreads; entries triggered by the existing RVOL alerts (or another rule the user
defines); exits by target, stop, time or session close; costs and fill models; a results
view.

Excluded: live or paper order placement (AGENTS.md: no trading without explicit
authorization, and the integration is market-data-only); early-assignment modelling; dates
before February 2024 (Alpaca options history starts then).

Possible phase 2, with explicit authorization only: a **shadow forward test**, recording
what the strategy would do on live alerts using real-time OPRA quotes, with no orders.

## Flow and states

1. **Define** (form): trigger, direction mapping, contract selection, exits, size, costs,
   fill model, date range (US session dates). Saved and versioned.
2. **Run:** shows progress (alerts found, contracts priced). It can take minutes; the run
   continues if the tab closes, and results are kept.
3. **Results:** a trade list (entry/exit in Israel time, contract, entry and exit prices,
   P&L, exit reason); an equity curve; trade count, win rate, average win/loss,
   expectancy, max drawdown and median holding time; the same for the baseline. With
   fewer than 30 trades it shows `too few trades to judge`.
4. **States:** `no option data for this contract/date` (the trade is skipped and counted);
   `no entry in range`; a provider error with retry; a partial run is labelled partial.
5. A permanent label: "Hypothetical results on historical data. Not a prediction or
   advice."

## Semantics and contract needs

Everything here is a proposed default; the strategy itself must come from the user.

- **Entry trigger:** an RVOL v3 alert (the backtest alert list), direction → call (up) or
  put (down).
- **Entry time:** the open of the first option bar after the alert bar closes (no
  look-ahead).
- **Contract selection:** expiry DTE and delta target as in
  [options context](options-context.md). Alpaca has no historical greeks, so delta is
  computed with Black-Scholes from the option and stock prices at entry (risk-free rate
  input; dividends ignored, flagged).
- **Fill model:** Alpaca historical options data provides bars and trades; historical
  quotes need verification. Default: a conservative fill at bar price ± half of an assumed
  spread (a parameter), with "mid" shown as an optimistic comparison. When quotes are
  available, buy at the ask and sell at the bid.
- **Costs:** a per-contract commission (default $0.65, IBKR-like) plus regulatory fees as a
  parameter.
- **Exits:** first hit of target % or stop % on bar closes, otherwise time stop N minutes,
  otherwise the session close. Same-bar target and stop counts as the stop (conservative).
- **Baseline:** the same rules with random entry minutes on the same tickers and dates, and
  the underlying-stock version of the trade, to show whether the signal adds anything.
- **Data limits shown:** feed (OPRA), the start-date limit, skipped trades, and whether
  fills were quote-based or bar-based.

## Acceptance scenarios

1. With 40 alerts in range and data for 36, the result shows 36 trades and `4 skipped (no
option data)`.
2. A target and stop both hit within one bar exit at the stop.
3. An entry never uses a price from the alert bar or earlier.
4. A run with 12 trades shows its statistics and `too few trades to judge`.
5. A range starting before Feb 2024 is clipped, with a notice.
6. Changing the fill model from conservative to mid changes P&L but not the trade list.

## Decisions and handoff

Blocking questions for the user (the strategy):

1. Which strategy? (For example buy a call/put on an RVOL alert, a debit spread, selling
   premium after a spike, or something you already trade.)
2. The entry trigger: the RVOL alerts as they are, only tier A, or another condition?
3. Contract: which DTE and delta (or strike rule)?
4. Exits: target %, stop %, maximum holding time, or always close by end of day?
5. Size: one contract, or a fixed $ risk per trade?
6. Do you have real trades of this strategy to compare against?

Backend: historical options client, pricing/greeks, simulator, run storage. Frontend:
strategy form, results. Integration: contract and the decision record.
