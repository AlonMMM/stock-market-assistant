// σ history of the area score vs SPY (docs/features/area-vs-spy.md, "Scale"):
// one per-minute σ curve per symbol and session date, computed from the
// previous 20 sessions of minute bars of the stock and SPY and stored per
// day like the Rel vol baselines (D1 on the Worker, SQLite locally and in
// the collector), so later requests that day need no history.
import {
  areaSigmaSessions,
  byDate,
  fromRawBars,
  sigmaCurve,
  type SigmaCurve,
} from "./area-vs-spy.js";
import type { D1Like } from "./bar-cache.js";
import type { RawBar } from "./bars.js";
import { benchmark } from "./beta.js";
import { newYorkToUtc, previousSessions } from "./calendar.js";
import { D1DailyStore, type DailyStore } from "./volume-baseline.js";

/** σ curves per symbol and session date. */
export type AreaSigmaStore = DailyStore<SigmaCurve>;

/** D1 table `area_sigma` in the bar-cache database (~8 KB per row). */
export class D1AreaSigmaStore extends D1DailyStore<SigmaCurve> {
  constructor(db: D1Like) {
    super(db, "area_sigma", "curve", 8);
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
  const dates = previousSessions(date, areaSigmaSessions);
  return {
    dates,
    // New York midnight of the first and of the scored date: no look-ahead.
    start: new Date(newYorkToUtc(dates[0]!, 0)).toISOString(),
    end: new Date(newYorkToUtc(date, 0)).toISOString(),
  };
}

/**
 * σ curves for `tickers` (not SPY) on `date`: stored curves first, then, for
 * at most `limit` missing symbols, their minute history and SPY's over the
 * previous 20 sessions, one symbol at a time (bounded memory). Computed
 * curves are stored. Failures leave a symbol without a curve (score null),
 * to retry on a later request. `betaOf` is the date's β vs SPY (1 assumed).
 */
export async function areaSigmas(
  tickers: string[],
  date: string,
  betaOf: (ticker: string) => number,
  history: MinuteHistory,
  store?: AreaSigmaStore,
  limit = Infinity,
): Promise<Map<string, SigmaCurve>> {
  const wanted = tickers.filter((t) => t !== benchmark);
  let curves = new Map<string, SigmaCurve>();
  if (!wanted.length) return curves;
  try {
    if (store) curves = await store.get(date, wanted);
  } catch {
    // Degrade to computing; the result stays correct.
  }
  const missing = wanted.filter((t) => !curves.has(t)).slice(0, limit);
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
  const fresh = new Map<string, SigmaCurve>();
  for (const ticker of missing) {
    try {
      const stock = fromRawBars(
        ticker,
        await history(ticker, range.start, range.end),
      );
      fresh.set(
        ticker,
        sigmaCurve(stock, spyDays, range.dates, betaOf(ticker)),
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
