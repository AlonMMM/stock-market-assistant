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

- `BacktestRun` (`packages/market-data/src/backtest.ts`): `runBacktest` split into a
  per-symbol step and a final ranking step; output byte-identical to before on a
  3-symbol × 20-session AAPL replay. Random minutes for look-now ranking are kept as
  one z per horizon (`RandomMinutes`), so millions of them fit in memory.
- `npm run backtest` (`scripts/backtest.ts`): offline backtest with no Worker limits,
  one symbol at a time, all symbols ranked together. Bars from
  `data/local/bars-cache.sqlite`, then D1 (copied locally), then Alpaca.
- Calendar extended to 2024–2025 (the user's earlier uncommitted change).
- 2026-10-04: 196 tickers from all IBKR watchlists (stocks plus equity ETFs; bond,
  volatility, commodity and currency funds dropped) saved to
  `data/local/backtest-tickers.txt` (git-ignored, account data); D1 backfilled with
  13 months of SIP bars for them.

- Per-symbol result cache for `npm run backtest`: `BacktestRun.compute` (one symbol,
  plain data) + `merge`; parts stored gzipped in the `backtest_parts` table of
  `data/local/bars-cache.sqlite`. Key = SHA-256 of rule version (`ruleVersion`,
  `rvol-v4`, exported from the evaluator), the evaluation sources, dates, rule and
  scoring settings, and the symbol; `rule` and `ticker` are plain columns for listing
  and cleanup. Cold, cached and `--no-cache` runs give deep-equal results (3 symbols:
  1.5 s → 0.2 s). Alpaca daily bars (β) are not part of the key; a later split
  adjustment would not invalidate a part.
- Complete runs stored in `backtest_runs` (same hash over the sorted symbol list;
  readable `rule`, `from_date`, `to_date`, `symbols`, `settings`, `summary`; gzipped
  full result). An identical rerun is served from it (full year: 0.8 s; from parts:
  20 s; computed: 10.5 min). Runs with failed symbols are not stored.
- First full run (2026-10-04, before the cache existed): 196 symbols × 252 sessions,
  42,907 alerts in 12.5 min; look-now big 17.6% vs 3.8% baseline, very big 5.3% vs
  0.7%; trade view good 34.9% vs 30.7%, stopped 61.5% vs 59.3%.

## Verification and handoff

- `npm run check` and `git diff --check` pass (191 pass, 1 skipped).
- A deploy of 0cadcf5c (fixed 4-symbol batches) was replaced two minutes later by the
  #36 deploy from main; this branch must merge before deploying so it is not lost.
- After deploy: run 11 symbols × 23 sessions and 1 symbol × 50 sessions on the site,
  watching `wrangler tail` for exceededCpu/exceededMemory.
- Contract change for Integration: the session cap and the per-request symbol limit
  in `/api/backtest` (backtest-page and relative-volume specs updated).
