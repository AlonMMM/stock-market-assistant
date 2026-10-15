# Stock Market Assistant — Product Backlog

**Updated:** 2026-10-15
**Product goal:** Help the owner monitor US stocks, understand unusual moves, test alert rules, and manage a paper options account from one mobile-friendly product.

This backlog separates code already present in `main` from work that still needs implementation or production evidence. Priorities are ordered by user value and by the dependencies between items.

## Current product baseline

Implemented in `main`:

- Live watchlist, relative-volume alerts, symbol management, and a two-hour per-symbol cooldown.
- Backtests using the same alert evaluator as live processing, with cached market data and request-size limits.
- Intraday charts with SPY comparison, marked periods, and alert analysis.
- Telegram alert delivery and technical, sentiment, news, and relative-strength analysis.
- Portfolio close / approximate-now views, option estimates, and a trade-level realized P&L history chart in dollars or percent.
- Paper options trading flows with position checks, sizing limits, stops, and order handling.

Code being present does not mean every external integration has been verified in production. The open work below focuses on those gaps and on the user's next explicit needs.

## P0 — Prove the live product works end to end

### 1. Validate the Alpaca collector and live alert pipeline

**User outcome:** Live alerts reflect the configured watchlist and reach the user reliably.

**Acceptance criteria:**

- Confirm the Railway collector is running with the intended Alpaca feed and credentials.
- Resolve and document the actual supported ticker capacity; the product goal is approximately 500 symbols, while current task notes describe a 50-symbol collector and a later 500-symbol setting.
- Verify closed one-minute bars, reconnect and restart behavior, duplicate suppression, and the 120-minute cooldown against production data.
- Follow one real alert from Alpaca through storage, analysis, Telegram delivery, and its link back to the correct alert in the site.
- Record the observed feed, watchlist size, and delivery result without exposing credentials.

**Dependencies:** Railway access, Alpaca market-data entitlement, and Telegram configuration.
**Existing notes:** [collector](tasks/alpaca-collector.md), [alert delivery](tasks/backend-telegram-notifications.md), [ticker controls](tasks/reduce-alert-noise.md).

### 2. Validate the approved alert configuration and quality

**User outcome:** Keep the alert stream useful without silently changing the rule.

**Acceptance criteria:**

- Confirm production uses the approved 4× volume thresholds and 120-minute ticker cooldown.
- Measure alert counts and follow-through on a held-out period; report the results separately for pre-market, regular, and post-market sessions.
- Keep this as measurement only. Do not add a price floor, adaptive move gate, liquidity/options screen, or other alert filter without explicit approval.

**Dependency:** Item 1 and a reproducible production configuration snapshot.

### 3. Validate real-data backtests and live/backtest parity

**User outcome:** Trust that a backtest represents the alerts the live engine would have emitted.

**Acceptance criteria:**

- Run credentialed Alpaca SIP checks for a small symbol set and compare reconstructed alerts with stored live bars where dates overlap.
- Verify missing sessions, feed differences, and the recent-data cutoff are visible to the user.
- Confirm cache hits return the same result as a cold run and requests stay within the Worker's CPU, memory, and subrequest limits.
- Keep signal reconstruction separate from trade P&L unless entry, exit, fill, and cost assumptions are explicitly defined.

**Dependencies:** Alpaca credentials and representative production bars.
**Existing notes:** [backtest](tasks/backend-alpaca-backtest.md), [resource limits and cache](tasks/backend-project-fixes.md).

## P1 — Improve portfolio estimates and paper-trading confidence

### 4. Include volatility change in overnight option estimates when available

**User outcome:** Make the approximate portfolio view more complete when an implied-volatility change can be observed.

**Acceptance criteria:**

- Add the vega contribution `vega × change in implied volatility` only when both inputs are valid and their units are known.
- Keep delta, gamma, and theta effects; show the volatility contribution in the compact estimate breakdown.
- When the change in implied volatility is unavailable, omit that contribution and label the estimate as partial instead of assuming zero volatility change.
- Add tests for positive, negative, and unavailable volatility changes, and verify account value, position value, and P&L use the same estimate.

**Existing code:** `packages/trading/src/portfolio.ts`; the current estimate records vega and implied volatility but leaves the volatility-change effect unknown.

### 5. Exercise the paper-order lifecycle during market hours

**User outcome:** Verify that partial fills, stops, cancellations, and exits behave safely with Alpaca's real paper API.

**Acceptance criteria:**

- Observe a paper buy through partial/full fills, stop coverage, and cancellation of any unfilled remainder.
- Exercise a paper sell with a working stop and partial fills; verify the remaining position is protected and never becomes short.
- Confirm failures are reported and do not claim a fill or stop that Alpaca did not confirm.
- Keep live-account trading out of scope until separately authorized.

**Dependencies:** Market hours and a paper account with suitable liquid contracts.
**Existing notes:** [paper option-order flow and open validation questions](tasks/backend-option-orders.md).

### 6. Show notification delivery state in the product

**User outcome:** Tell whether an alert reached Telegram without checking service logs.

**Acceptance criteria:**

- Expose `pending`, `sent`, `failed`, or `expired` for recent alerts in the Live view.
- Provide a concise failure reason and a retry action only where retry is safe and cannot create duplicate messages.
- Keep synthetic and backtest alerts clearly separate from live notifications.

**Dependency:** A site API contract for the collector's durable notification outbox.
**Existing notes:** [Telegram notifications](tasks/backend-telegram-notifications.md).

## P2 — Scale and extend only after the core is verified

### 7. Measure readiness for the approximately 500-symbol goal

**User outcome:** Grow the live universe without losing bars, alerts, or acceptable response times.

**Acceptance criteria:**

- Benchmark the collector, Alpaca plan limits, storage, and Cloudflare request budgets at increasing watchlist sizes.
- Identify the safe supported size and any batching or subscription limits.
- Present the cost and reliability trade-offs before changing the production universe.

**Dependency:** Item 1.

### 8. Specify the next alert family

**User outcome:** Add another signal only when its meaning and evaluation are clear.

**Candidate families from the original product brief:** breakouts/new highs or lows, momentum, and pullbacks.

**Acceptance criteria before implementation:**

- The user selects one family and approves its exact formula, timeframe, session behavior, thresholds, cooldown, and edge cases.
- Historical evaluation uses only data available at the alert time and reports false positives as well as successful outcomes.
- The new rule is versioned and uses the same deterministic evaluator in live alerts and backtests.

**Status:** Deferred. No additional alert family or filter is approved in this backlog yet.

## Product constraints

- Keep the current relative-volume baseline at 4× with a 120-minute cooldown until the user approves a change.
- Display user-facing times in Israel time.
- Keep the automated trading account in paper mode. Live trading requires separate authorization.
- Label model-based after-hours prices as estimates, not executable option quotes.
- Do not infer profitability from alert replay alone; a trading backtest needs explicit execution and cost assumptions.
