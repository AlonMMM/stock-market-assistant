# Feature: 500-ticker universe and alert scoring

Status: proposed
Owner: product-ux
Spec revision: pending user agreement

## User and outcome

The confirmed goal is to monitor about 500 tickers. SIP allows unlimited stock WebSocket
symbols, but ten times the symbols means roughly ten times the alerts. The trader needs
the phone to buzz only for the strongest alerts, while everything else stays browsable in
the site.

Observable result: the collector watches about 500 symbols. Each alert gets a tier (A, B
or C) with a one-line reason; only tier A reaches Telegram and gets the Claude analysis,
within a daily push budget.

## Scope and exclusions

In scope: universe definition and refresh; a sector-benchmark mapping for every symbol;
an instant score and tier at alert time; push routing by tier; quiet hours and a daily
budget; tier filters in the feed.

Excluded: a self-learning score (it comes after [outcome tracking](alert-outcomes.md) has
enough data); multi-user watchlists; non-US markets.

## Flow and states

- **Settings → Universe:** shows the current list (count, source, last refresh), the
  user's additions and removals, and each symbol's sector benchmark. Saving takes effect
  at the next collector restart or resubscribe, and the screen shows that it is pending.
- **Feed:** a tier badge (`A`, `B`, `C`, with a letter and not only colour), a default
  filter of A+B, and a one-line reason, e.g. `A · 6.1× vol, move 4.2× usual, $48M traded`.
- **Telegram:** tier A only. When the daily budget is spent, further A alerts are marked
  `over budget` in the feed and one Telegram line says the budget is reached. Quiet
  hours (Israel time) hold pushes; held alerts are not sent later (the same as mute).
- **Warmup:** after a restart, symbols show `warming up` until 20 sessions are loaded; the
  health endpoint reports progress (n / 500).
- **Errors:** a symbol rejected by the provider is listed as `unavailable` with the reason;
  the rest keep running.

## Semantics and contract needs

Proposed defaults, to be approved:

- **Universe** = S&P 500 constituents ∪ the user's watchlist − the user's removals. Alpaca
  does not publish index membership, so the constituent list is a committed config file
  refreshed manually each month (open question: the source and who owns it).
- **Sector benchmark:** the SPDR sector ETF by GICS sector (XLK, XLF, XLE, XLV, XLY, XLP,
  XLI, XLB, XLU, XLRE, XLC). An explicit watchlist mapping (e.g. MSTR → IBIT) overrides it.
- **Instant score (0–100)**, available at alert time and computed only from alert evidence
  plus a quote:
  - volume strength: `ratio` (or `paceRatio`) relative to the threshold;
  - move strength: |move| ÷ expectedMove;
  - liquidity: window dollar volume and the current bid/ask spread % (SIP quotes);
  - relative strength vs SPY on the window horizon (cheap; the full RS score stays in the
    analysis).

  The weights and tier cutoffs are **not specified here**. Proposed method: start with an
  equal-weight percentile score and A = top 10% of the trailing 20 sessions' alerts, then
  replace the weights with outcome-tracking evidence (hit rate by component). The user
  approves the method.

- **Tiers:** A = push and analyze; B = feed only; C = feed only, hidden by default (for
  example a spread > 0.5% or dollar volume below a floor).
- **Budget:** at most N A-pushes per day (proposed 15) and 3 per ticker per day. Quiet hours
  are off by default.
- The analysis runs for A only, to bound Claude cost. An "Analyze" button on a B or C alert
  is an option for later.
- **Capacity:** 500 × 20 sessions of minute warmup is fine under 10,000 requests/min; the
  store grows about 10×, so retention must be confirmed (Backend).

## Acceptance scenarios

1. With 500 symbols the collector reaches `subscribed` and the health endpoint shows
   500/500 warmed.
2. An alert in the top decile is tier A, is sent to Telegram and gets an analysis; a
   tier B alert appears in the feed only.
3. After 15 A-pushes in a day, the 16th A alert is in the feed marked `over budget`, and
   one notice line was sent.
4. A 4th A alert for the same ticker that day is not pushed.
5. A symbol with no sector mapping uses SPY only, and its reason line says so.
6. A delisted or invalid symbol shows `unavailable` and does not stop the others.

## Decisions and handoff

Open questions: the universe source (S&P 500 vs Russell 1000 vs custom); the push budget
and quiet hours; whether tier C should exist or be dropped; whether B alerts get a daily
digest.

Depends on [alert outcomes](alert-outcomes.md) for calibration and on the SIP plan. Backend:
universe config, score, routing. Frontend: badges, filters, settings. Integration:
contract, state.
