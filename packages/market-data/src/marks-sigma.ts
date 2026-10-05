// σ history of the marked-sections score vs SPY
// (docs/features/marks-vs-spy.md, "Scale"): one per-minute σ curve per
// symbol and session date, computed from the previous 20 sessions of minute
// bars of the stock and SPY and stored per day like the Rel vol baselines
// (D1 on the Worker, SQLite locally and in the collector), so later requests
// that day need no history.
import type { D1Like } from "./bar-cache.js";
import type { RawBar } from "./bars.js";
import { benchmark } from "./beta.js";
import { newYorkToUtc, previousSessions } from "./calendar.js";
import {
  byDate,
  fromRawBars,
  historyMarks,
  marksSigmaSessions,
  sigmaCurve,
  type MarkBar,
  type MarksSigma,
} from "./marks-vs-spy.js";
import { D1DailyStore, type DailyStore } from "./volume-baseline.js";

/** σ curves per symbol and session date. */
export type MarksSigmaStore = DailyStore<MarksSigma>;

/** Rows per INSERT of σ curves (~3 KB each; a D1 statement allows 100 KB). */
export const sigmaRowsPerInsert = 16;

/**
 * D1 table `marks_sigma` in the bar-cache database. It replaces the area
 * score's `area_sigma` table, which is no longer read or written.
 */
export class D1MarksSigmaStore extends D1DailyStore<MarksSigma> {
  constructor(db: D1Like) {
    super(db, "marks_sigma", "curve", sigmaRowsPerInsert);
  }
}

/** Minute bars of one symbol for [start, end) (bar cache when configured). */
export type MinuteHistory = (
  ticker: string,
  start: string,
  end: string,
) => Promise<RawBar[]>;

/** The previous sessions and the [start, end) range their bars span. */
export function sigmaRange(date: string) {
  const dates = previousSessions(date, marksSigmaSessions);
  return {
    dates,
    // New York midnight of the first and of the scored date: no look-ahead.
    start: new Date(newYorkToUtc(dates[0]!, 0)).toISOString(),
    end: new Date(newYorkToUtc(date, 0)).toISOString(),
  };
}

/**
 * σ curve of `ticker` from its and SPY's bars over `dates` (bars grouped by
 * date; only those dates are read). The first date's previous close is its
 * first regular open (its previous session is outside the range).
 */
export function sigmaFromBars(
  ticker: string,
  stock: MarkBar[] | Map<string, MarkBar[]>,
  spy: Map<string, MarkBar[]>,
  dates: string[],
  beta: number,
): MarksSigma {
  const stockDays = stock instanceof Map ? stock : byDate(stock);
  return sigmaCurve(
    (date) => historyMarks(ticker, stockDays, spy, date),
    dates,
    beta,
  );
}

/**
 * σ curves for `tickers` (not SPY) on `date`: stored curves first, then, for
 * at most `limit` missing symbols, their minute history and SPY's over the
 * previous 20 sessions, one symbol at a time (bounded memory). Computed
 * curves are stored (one write). Failures leave a symbol without a curve
 * (score null), to retry on a later request. `betaOf` is the date's β vs SPY
 * (1 assumed).
 */
export async function marksSigmas(
  tickers: string[],
  date: string,
  betaOf: (ticker: string) => number,
  history: MinuteHistory,
  store?: MarksSigmaStore,
  limit = Infinity,
  offset = 0, // rotates which missing symbols are computed first
): Promise<Map<string, MarksSigma>> {
  const wanted = tickers.filter((t) => t !== benchmark);
  let curves = new Map<string, MarksSigma>();
  if (!wanted.length) return curves;
  try {
    if (store) curves = await store.get(date, wanted);
  } catch {
    // Degrade to computing; the result stays correct.
  }
  const all = wanted.filter((t) => !curves.has(t));
  const start = all.length ? offset % all.length : 0;
  const missing = [...all.slice(start), ...all.slice(0, start)].slice(0, limit);
  if (!missing.length) return curves;
  let range: ReturnType<typeof sigmaRange>;
  try {
    range = sigmaRange(date);
  } catch {
    return curves; // outside calendar coverage: no σ
  }
  let spy;
  try {
    spy = fromRawBars(
      benchmark,
      await history(benchmark, range.start, range.end),
    );
  } catch {
    return curves; // SPY history unavailable: no σ this time
  }
  if (!spy.length) return curves;
  const spyDays = byDate(spy);
  const fresh = new Map<string, MarksSigma>();
  for (const ticker of missing) {
    try {
      const stock = fromRawBars(
        ticker,
        await history(ticker, range.start, range.end),
      );
      fresh.set(
        ticker,
        sigmaFromBars(ticker, stock, spyDays, range.dates, betaOf(ticker)),
      );
    } catch {
      // This symbol's history failed: retried on a later request.
    }
  }
  for (const [t, curve] of fresh) curves.set(t, curve);
  try {
    await store?.put(date, fresh);
  } catch {
    // Not stored this time; recomputed on a later request.
  }
  return curves;
}
