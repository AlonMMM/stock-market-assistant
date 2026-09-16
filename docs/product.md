# Product scope

## Confirmed user goals

- A website that assists stock-market traders.
- Start by monitoring approximately 500 tickers and identifying events defined by the user.
- Display alerts in the website and deliver notifications to a phone.
- Open the alerted ticker's chart with comparisons against its sector and a market index.
- Make alert settings configurable.
- Run alert rules against historical data.

## Initial alert families

The user supplied an image describing breakouts/new highs and lows, percentage change and momentum, pullbacks, and volume-related signals.
The image also notes extended-session considerations, deferred bid/ask-based rules, and consolidation as volatility contraction.
These are discovery notes, not executable definitions. Exact codes, formulas, thresholds, windows, rearming behavior, and edge cases require a verified specification before implementation.

## Immediate scope

Implement relative-volume alerts first: US stocks including extended hours, evaluated on minute close. See [the initial contract](features/relative-volume.md). The first increment uses synthetic demo or normalized uploaded historical bars.

## Unresolved choices

- Market coverage, ticker universe ownership, session/calendar behavior.
- Seconds versus bar-close latency and historical data resolution.
- Market-data provider, permissions, history depth, and budget.
- Hosting. The user selected TypeScript throughout, React for the web, and Node.js for the backend.
- Phone delivery channel and authentication/multi-user needs.
- Sector mapping, comparison benchmarks, and chart source.
- Precise rule definitions, missing/late data behavior, and duplicate suppression.

## Proposed design directions — not yet approved

- Share deterministic alert evaluation between live processing and historical replay.
- Version rules and configuration, and retain the evidence behind each alert.
- Historical replay must use only information available at the simulated event time.
- Distinguish alert replay from strategy profitability; a P&L backtest also needs entry, exit, costs, and fill assumptions.
- Keep execution of brokerage orders outside the initial scope unless requested.
