# Task: Per-symbol baseline for the Backtest page

Status: completed
Owner: backend
Branch: session/backend-backtest-page
Spec/contract revision: fd18ce5 (`docs/features/backtest-page.md`, "Semantics and contract needs", scenario 6)

## Outcome

`POST /api/backtest` returns `validation.baselineBySymbol`, so the Backtest page's
By-symbol tab can show each symbol's good % against that symbol's own random-entry
baseline.

## Scope and exclusions

In scope: the additive response field, its shared type, local API / Worker parity, tests.
Excluded: rule evaluation, outcome scoring, existing fields, the web `merge()` of batches
and every other web change (Frontend task `frontend-backtest-page`).

## Relevant context

- Contract type: `BaselineCounts` and `ValidationSummary.baselineBySymbol` in
  `packages/market-data/src/outcome.ts` (commit 94b5cfe, mergeable on its own).
- Implementation: `runBacktest` in `packages/market-data/src/backtest.ts`, shared by
  `apps/api/src/app.ts` and `apps/api/src/worker.ts` through `handleBacktest`.

## Acceptance criteria

- `validation.baselineBySymbol: Record<ticker, { scored, good, stopped, weak }>` holds
  the same baseline entries as `validation.baseline`, split by symbol; the sum over
  symbols equals `validation.baseline` for every count.
- Every requested ticker has a key. A ticker with no scored baseline entries (no bars,
  flat prices, missing history) has all zeros, so a missing key or map means "unknown"
  (older API), never zero; the web shows "—" then (scenario 6).
- Existing fields and values are unchanged; no extra Alpaca requests or cache statements.
- Local API and Worker return identical values.

## Plan and assumptions

- Decision: present-with-zeros rather than absent, so the Frontend can tell "this API
  has no per-symbol data" (absent) from "this symbol had no baseline entries" (zeros).
- Decision: the type is optional (`baselineBySymbol?`) on `ValidationSummary`, because
  `summarize()` does not set it, merged results may not, and older API responses lack it.
  `runBacktest` always sets it.
- `summarize()` now uses the exported `baselineCounts()` helper; its output is unchanged
  (`scored` is still the list length).
- Batches cover disjoint tickers, so the Frontend can merge the maps by spreading them
  (`{ ...a, ...b }`); if any batch lacks the map, the merged result should treat the
  missing tickers as unknown.
- Cost: one extra pass of counts per symbol over outcomes already computed; no I/O.

## Verification evidence

- `node --import tsx --test tests/backtest.test.ts`: 8/8 pass. New tests: synthetic
  zigzag bars (AAPL, MSFT) and flat bars (FLAT) check the split, the sums, zeros for
  FLAT, that each symbol equals its own solo-run baseline, and the validation key set
  (old keys plus `baselineBySymbol`); a fake Alpaca (placeholder keys) checks local API
  and Worker return the same map; the existing contract test checks zeros with no bars.
- `npm run check`: exit 0 (format, typecheck API and web, 159 tests pass, build).
- `git diff --check`: clean.
- Limitation: synthetic data only; not run against real Alpaca.

## Handoff

- Commits: 94b5cfe (contract type), then the implementation/tests commit and this file
  (see `git log session/backend-backtest-page`).
- Frontend: merge `baselineBySymbol` across batches in `apps/web/src/Backtest.tsx`
  `merge()` (it currently rebuilds `validation` from `summarize()`, which drops the map).
- Integration: record the additive `/api/backtest` field in docs/state.md on merge.
