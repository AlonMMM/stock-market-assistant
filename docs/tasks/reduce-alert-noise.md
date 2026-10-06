# Reduce alert noise

User request: 2026-10-06. Implementation branch: codex/reduce-alert-noise.

## Behavior

Shared live/backtest defaults are now rvol-v5: both historical volume and today's
pace paths require 5×. Stocks below $10 cannot alert. The price move must exceed
all applicable floors: 0.5%, 3× its historical time-of-day median, 3× today's
median window move, and 20% of today's observed range before the candidate window.
Today's median needs 15 prior windows; the range includes extended hours and the
prior regular close (overnight gaps). The candidate and future bars are excluded.
A 9% observed range therefore needs ≥1.8%, instead of accepting 1–1.5%.
This is the same-day range, not yesterday's entire range carried into today.

All gates are configurable in Backtest. Evidence shows the effective required
move and prior range. rvol-v5 plus evaluation-code hashing prevents old cache reuse.
Old alerts remain readable. Existing backtest fixtures explicitly retain their
legacy optional gates where they test v3/v4 semantics.

## Universe liquidity

Backtest → Symbols → Screen stock liquidity previews the shared list using the
last 20 completed US sessions of SIP daily bars. Stocks must have price ≥$10,
average daily volume ≥1M shares and average dollar volume ≥$50M. These liquidity
cutoffs are starting proposals, not validated optimums. Removal uses the existing
symbol-list endpoint and syncs the collector. ETFs remain; symbols with missing
history remain for review. The shared list is authoritative, so a removed stock
cannot reappear through the older IBKR display watchlist or quick picks.

`npm run screen:symbols` discovers all active tradable optionable Alpaca assets;
`--symbols AAPL,PLUG` restricts liquidity screening. `--options` on a shortlist
retrieves all paginated 7–30 DTE OPRA snapshots and reports each contract's quote
spread and delta. This script only writes a report, never changes the list.
Example using credentials already configured in Railway:

```sh
railway run -- npm run screen:symbols -- --symbols AAPL,PLUG --options
```

The reported stock price is the last completed session's close; the shared alert
engine additionally enforces the current $10 price floor. Dollar volume uses
provider VWAP × shares, with a labeled close-price estimate if VWAP is missing.
Current-universe results must not filter old backtests (survivorship bias).

## Proposed options filter

Per contract: (ask − bid) / midpoint ≤5% AND absolute spread ≤$0.10; positive bid,
noncrossed quote, positive sizes, timestamp no more than 60 seconds old. Use OPRA;
the indicative feed modifies quotes and is not suitable for execution screening.
This is a starting proposal, not an activated stock alert filter. A wide contract
does not exclude all contracts on its underlying. Do not interpret an after-hours
stale quote as proof that the underlying has no liquid options.

Alpaca docs: https://docs.alpaca.markets/us/reference/getassets,
https://docs.alpaca.markets/us/reference/optionchain,
https://docs.alpaca.markets/us/docs/historical-option-data.
Assets docs now use `has_options`; discovery also accepts the legacy
`options_enabled` attribute.

## Validation and limits

Synthetic tests cover dynamic range/overnight gaps, window/future exclusion,
price eligibility, list preservation, missing history, pagination, and quote
spread/freshness. Live retrieval is blocked in this session: Railway OAuth
returns variable names only, and plugin discovery found no Alpaca connector.
No live list removals, real Alpaca chain retrieval, or deployment occurred.
The change has not been rerun against yesterday's actual backtest; alert-count
reduction and signal-quality impact are unmeasured.

Verified: `npm run doctor`, `npm run check` (formatting, types, 256 passing tests,
1 skipped existing test, builds), and `git diff --check`. UI interactions were
not exercised in a browser in this session.
