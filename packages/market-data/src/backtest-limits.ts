// Request limits for /api/backtest, shared by the Worker and the Backtest page.
//
// Memory, not CPU, bounds a request on Workers Paid: an isolate has 128 MB.
// Smallest Node heap that completed a request with cached bars, minus ~30 MB
// for the harness (2026-10-03, 20 warmup sessions unless noted):
//   1 symbol: 1 session ~5 MB, 20 → 28, 40 → 52, 80 → 95
//   2 symbols: 20 → 38, 40 → 66, 80 → 128;  4 symbols × 20 → 57;  8 × 1 → 28
//   1 symbol × 20 sessions with 60 warmup sessions → 66
// The estimate below is at or above every measurement (±8 MB noise). The budget
// admits 4 symbols × 20 sessions, leaving about half the isolate for the
// runtime and garbage between collections.
export const backtestLimits = { tickers: 10, sessions: 50 };
const budgetMB = 65;

/** Estimated peak heap (MB) of one request; warmup past 20 counts as range. */
export function backtestMemoryMB(
  symbols: number,
  sessions: number,
  warmupSessions: number,
): number {
  const days = sessions + Math.max(0, warmupSessions - 20);
  return 5 + 3 * symbols + days * (0.7 + 0.42 * symbols);
}

/** Most symbols one request can hold for a range (0 when none fit). */
export function maxSymbolsPerRequest(
  sessions: number,
  warmupSessions: number,
): number {
  let n = 0;
  while (
    n < backtestLimits.tickers &&
    backtestMemoryMB(n + 1, sessions, warmupSessions) <= budgetMB
  )
    n++;
  return n;
}
