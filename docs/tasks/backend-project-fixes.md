# Task: project-fixes

Owner: backend
Status: in progress
Branch: session/backend-project-fixes

## Outcome

Fix intermittent HTTP 503 from backtests and prepare for the Workers Paid plan.

## Findings (2026-10-03)

- **Backtest 503s are Cloudflare error 1102 (resource limits), not app errors.** The
  Worker never returns 503 itself. Workers Free allows 10 ms CPU per request; a fully
  cached 3-symbol batch measured locally (Node, real AAPL bars from D1, 0 Alpaca
  fetches) used ~200–300 ms for 1 session and ~770–1000 ms for 20. Cache decoding is
  ~10% of that; the evaluator, outcome scoring and New York calendar conversion
  dominate. Cloudflare tolerates occasional overruns, hence intermittent failures.
- **Memory is the next bound.** 128 MB per isolate on both plans. Smallest Node heap
  that completed a cached request, minus ~30 MB of harness (main at 7c795cd): 1 symbol
  × 20/40/80 sessions ≈ 28/52/95 MB; 2 × 20/40/80 ≈ 38/66/128 MB; 4 × 20 ≈ 57 MB;
  8 × 1 ≈ 28 MB; 1 × 20 with 60 warmup sessions ≈ 66 MB. Range sessions dominate;
  warmup beyond 20 costs about as much. ±8 MB noise from GC timing.
- **D1 cache:** 64 tickers, 2024-09-26 → 2026-10-02, ~17–19 M bars (estimated from
  three decoded tickers), 342 MB of the free plan's 500 MB, ~2.4 MB per ticker-year.
  Filled only on demand (backtests, day charts, backfill script); live bars stay in
  the collector's SQLite for 120 days.
- **Not fixed, proposed:** the collector's restart refill only detects wholly missing
  days, so mid-day stream gaps on past days suppress alerts at those minutes until the
  day leaves the 20-session baseline. Early-close days compare the closing rush with
  normal days' midday minutes.

## Changes

- `packages/market-data/src/backtest-limits.ts`: a conservative memory estimate
  (`5 + 3·symbols + sessions·(0.7 + 0.42·symbols)` MB, warmup past 20 counted as
  sessions) with a 65 MB budget that admits 4 symbols × 20 sessions.
  `/api/backtest` rejects requests over budget (HTTP 400, "Choose …" message so the
  page stops instead of retrying). Session cap 20 → 50.
- Backtest page sizes batches from the range (`symbolsPerBatch`): 10 symbols at 1
  session, 4 at 20, 3 at 23, 2 at 30, 1 at 40–50. Previously a fixed 3.
- Requires Workers Paid (active since 2026-10-03); on the free plan any batch exceeds
  the 10 ms CPU limit.

## Verification and handoff

- `npm run check` and `git diff --check` pass (191 pass, 1 skipped).
- A deploy of 0cadcf5c (fixed 4-symbol batches) was replaced two minutes later by the
  #36 deploy from main; this branch must merge before deploying so it is not lost.
- After deploy: run 11 symbols × 23 sessions and 1 symbol × 50 sessions on the site,
  watching `wrangler tail` for exceededCpu/exceededMemory.
- Contract change for Integration: the session cap and the per-request symbol limit
  in `/api/backtest` (backtest-page and relative-volume specs updated).
