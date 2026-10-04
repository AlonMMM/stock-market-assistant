// Marked-sections score vs SPY (docs/features/marks-vs-spy.md). Pure: the
// collector, the day chart, the board and the backtest share it.
//
// For a symbol and an end minute E (regular session; New York start minutes,
// 09:30 = 570, index k = minute − 570):
//   marks   opposite()'s per-minute states (green "strong", red "weak"),
//           unchanged thresholds; only minutes i ≤ E count
//   c(i)    = tR(i) − β · bR(i), the stock's and SPY's 5-minute moves (%
//           points from the previous close, as in opposite()); 0 unmarked
//   w(i)    = (60 − (E − i)) / 60 for 0 ≤ E − i < 60, else 0
//   I       = Σ w(i) · c(i)
//   σ       = RMS of I at the same minute over the previous 20 sessions
//           (≥ 15 with data; a session without marks counts as I = 0)
//   score   = round(100 · Φ(I / σ))
// Because c is linear in β, I = T − β · B with T and B the weighted sums of
// tR and bR alone: a session's marks are computed once, without β.
import {
  marksWeightMinutes,
  type MarksVsSpySeries,
} from "../../contracts/src/vs-spy.js";
import { normalize, type PriceBar, type RawBar } from "./bars.js";
import { coreClose, newYorkToUtc, previousSessions } from "./calendar.js";
import type { ChartBar, ChartSeries } from "./day-chart.js";
import { opposite, type OppositeKind } from "./opposite.js";

/** σ history: previous sessions examined and the minimum with data. */
export const marksSigmaSessions = 20;
export const marksSigmaMinimum = 15;
/** First New York minute of the regular session (index k = 0). */
export const regularOpen = 570;
/** SPY is never scored against itself. */
export const marksBenchmark = "SPY";

/** A minute bar with its New York session date. */
export interface MarkBar extends ChartBar {
  date: string;
}

export const fromPriceBar = (bar: PriceBar): MarkBar => ({
  date: bar.date,
  start: Date.parse(bar.end) / 1000 - 60, // PriceBar.end is the bar's end
  session: bar.session,
  open: bar.open,
  close: bar.close,
  volume: bar.volume,
});

/** Mark bars from raw Alpaca rows (bars outside the sessions are dropped). */
export function fromRawBars(ticker: string, rows: RawBar[]): MarkBar[] {
  const result: MarkBar[] = [];
  for (const row of rows) {
    const bar = normalize(ticker, row, "shares");
    if (bar)
      result.push({
        date: bar.date,
        start: row.start,
        session: bar.session,
        open: bar.open,
        close: bar.close,
        volume: bar.volume,
      });
  }
  return result;
}

/** Bars grouped by New York date, each date in time order. */
export function byDate(bars: MarkBar[]): Map<string, MarkBar[]> {
  const result = new Map<string, MarkBar[]>();
  for (const bar of bars) {
    const list = result.get(bar.date);
    if (list) list.push(bar);
    else result.set(bar.date, [bar]);
  }
  for (const list of result.values()) list.sort((a, b) => a.start - b.start);
  return result;
}

/**
 * Previous close for `date`: the last regular close of the previous session
 * when `days` holds it, else (the first day of a history range) the date's
 * first regular open, else null. The fallback only rescales that day's moves
 * by its opening gap.
 */
export function previousCloseOf(
  days: Map<string, MarkBar[]>,
  date: string,
): number | null {
  let previous: string | undefined;
  try {
    previous = previousSessions(date, 1)[0];
  } catch {
    previous = undefined;
  }
  const before = previous ? days.get(previous) : undefined;
  const lastRegular = before?.findLast((b) => b.session === "regular");
  if (lastRegular) return lastRegular.close;
  return days.get(date)?.find((b) => b.session === "regular")?.open ?? null;
}

/** One date's chart series for opposite(), from bars grouped by date. */
export function daySeries(
  ticker: string,
  days: Map<string, MarkBar[]>,
  date: string,
  previousClose = previousCloseOf(days, date),
): ChartSeries {
  return { ticker, previousClose, bars: days.get(date) ?? [] };
}

/** One date's marks per regular minute k, β-free. */
export interface DayMarks {
  date: string;
  start: number; // Unix s of 09:30 New York (k = 0)
  minutes: number; // regular-session minutes that day (390, 210 early close)
  mark: (OppositeKind | null)[];
  tR: Float64Array; // stock's 5-minute move of a marked minute, else 0
  bR: Float64Array; // SPY's 5-minute move of a marked minute, else 0
  stockFirst: number; // first k with a stock regular bar (Infinity: none)
  stockLast: number; // last k with a stock regular bar (−1: none)
  spyFirst: number; // first k with SPY data (Infinity: none or no base)
}

/**
 * Marks of `date` from one-date series of the stock and SPY (bars of other
 * dates must not be passed: opposite() keeps today's usual moves). Marks at
 * minute i use only bars at or before i, so slicing at E is look-ahead free.
 */
export function dayMarks(
  stock: ChartSeries,
  spy: ChartSeries,
  date: string,
): DayMarks {
  const close = coreClose(date) ?? 960;
  const minutes = close - regularOpen;
  const result: DayMarks = {
    date,
    start: 0,
    minutes,
    mark: new Array<OppositeKind | null>(minutes).fill(null),
    tR: new Float64Array(minutes),
    bR: new Float64Array(minutes),
    stockFirst: Infinity,
    stockLast: -1,
    spyFirst: Infinity,
  };
  result.start = newYorkToUtc(date, regularOpen) / 1000;
  const index = (bar: ChartBar) => (bar.start - result.start) / 60;
  for (const bar of spy.bars)
    if (bar.session === "regular" && spy.previousClose) {
      result.spyFirst = Math.min(result.spyFirst, index(bar));
      break;
    }
  const o = opposite(stock, spy);
  stock.bars.forEach((bar, i) => {
    if (bar.session !== "regular") return;
    const k = index(bar);
    if (!Number.isInteger(k) || k < 0 || k >= minutes) return;
    result.stockFirst = Math.min(result.stockFirst, k);
    result.stockLast = Math.max(result.stockLast, k);
    const state = o.states[i];
    if (!state) return;
    result.mark[k] = state;
    result.tR[k] = o.tickerMoves[i]!;
    result.bR[k] = o.benchMoves[i]!;
  });
  return result;
}

const weight = (age: number) =>
  age >= 0 && age < marksWeightMinutes
    ? (marksWeightMinutes - age) / marksWeightMinutes
    : 0;

/** β-free weighted sums T (of tR) and B (of bR) with E = each minute k. */
export function weightedSums(m: DayMarks): {
  T: Float64Array;
  B: Float64Array;
} {
  const T = new Float64Array(m.minutes);
  const B = new Float64Array(m.minutes);
  for (let i = 0; i < m.minutes; i++) {
    if (!m.mark[i]) continue;
    const last = Math.min(m.minutes - 1, i + marksWeightMinutes - 1);
    for (let e = i; e <= last; e++) {
      const w = weight(e - i);
      T[e]! += w * m.tR[i]!;
      B[e]! += w * m.bR[i]!;
    }
  }
  return { T, B };
}

/**
 * I = Σ w(i) · c(i) with E = minute k: T − β·B summed in the same order as
 * weightedSums, so the alert's value equals the chart's at the same minute.
 */
export function sumAt(m: DayMarks, k: number, beta: number): number {
  let t = 0;
  let b = 0;
  for (let i = Math.max(0, k - marksWeightMinutes + 1); i <= k; i++)
    if (m.mark[i]) {
      const w = weight(k - i);
      t += w * m.tR[i]!;
      b += w * m.bR[i]!;
    }
  return t - beta * b;
}

/** σ per regular minute k (index = New York minute − 570); null = none. */
export type MarksSigma = (number | null)[];

/**
 * σ curve for a scored date from the previous sessions `dates` (the last
 * `marksSigmaSessions` are used; pass only dates before the scored date).
 * `history(date)` gives a session's marks, or null without data for the
 * stock or SPY that day (not counted). A counted session without marks adds
 * I = 0. RMS of I = T − β·B per minute over the sessions open at that
 * minute; null with fewer than `marksSigmaMinimum` or σ = 0. Values keep 4
 * significant digits (stored per day).
 */
export function sigmaCurve(
  history: (date: string) => DayMarks | null,
  dates: string[],
  beta: number,
): MarksSigma {
  const sq = new Float64Array(390);
  const n = new Uint8Array(390);
  for (const date of dates.slice(-marksSigmaSessions)) {
    const m = history(date);
    if (!m) continue;
    const { T, B } = weightedSums(m);
    for (let k = 0; k < m.minutes && k < 390; k++) {
      const value = T[k]! - beta * B[k]!;
      sq[k]! += value * value;
      n[k]!++;
    }
  }
  return Array.from(sq, (total, k) => {
    const sigma = n[k]! >= marksSigmaMinimum ? Math.sqrt(total / n[k]!) : 0;
    return sigma > 0 ? Number(sigma.toPrecision(4)) : null;
  });
}

/**
 * A session's marks for σ history, from bars grouped by date (stock and
 * SPY); null when either has no regular bar that day or no base.
 */
export function historyMarks(
  ticker: string,
  stockDays: Map<string, MarkBar[]>,
  spyDays: Map<string, MarkBar[]>,
  date: string,
): DayMarks | null {
  const stock = daySeries(ticker, stockDays, date);
  const spy = daySeries(marksBenchmark, spyDays, date);
  if (stock.previousClose === null || spy.previousClose === null) return null;
  const m = dayMarks(stock, spy, date);
  return m.stockLast < 0 || m.spyFirst === Infinity ? null : m;
}

/**
 * Standard normal CDF via erf, Abramowitz & Stegun 7.1.26 (absolute error of
 * erf below 1.5e-7).
 */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** round(100 · Φ(I / σ)); null without both or with σ ≤ 0. */
export function marksScore(
  sum: number | null | undefined,
  sigma: number | null | undefined,
): number | null {
  if (
    sum === null ||
    sum === undefined ||
    !Number.isFinite(sum) ||
    sigma === null ||
    sigma === undefined ||
    !(sigma > 0)
  )
    return null;
  return Math.round(100 * normalCdf(sum / sigma));
}

export interface MarksValue {
  sum: number | null; // I, % points; null when not scorable (see marksAt)
  sigma: number | null;
  score: number | null; // 0–100; null also without σ or with σ = 0
}

const none: MarksValue = { sum: null, sigma: null, score: null };

/**
 * Sum, σ and score of `ticker` with end minute E (New York start minute).
 * Not scorable (all null): SPY itself, E outside the regular session, no
 * SPY data at or before E, or no stock regular bar at or before E.
 */
export function marksAt(
  ticker: string,
  m: DayMarks,
  end: number,
  beta: number,
  sigma: MarksSigma | null | undefined,
): MarksValue {
  if (ticker === marksBenchmark) return none;
  const k = end - regularOpen;
  if (k < 0 || k >= m.minutes || k < m.spyFirst || k < m.stockFirst)
    return none;
  const sum = sumAt(m, k, beta);
  const s = sigma?.[k] ?? null;
  return { sum, sigma: s, score: marksScore(sum, s) };
}

const round4 = (x: number) => Number(x.toFixed(4));

/**
 * Per-minute series for the day chart (see MarksVsSpySeries): minutes 09:30
 * through the stock's last regular bar.
 */
export function marksSeries(
  ticker: string,
  m: DayMarks,
  beta: number,
  betaAssumed: boolean,
  sigma: MarksSigma | null,
): MarksVsSpySeries {
  const n = m.stockLast + 1;
  const result: MarksVsSpySeries = {
    start: m.start,
    contribution: [],
    mark: [],
    sum: [],
    sigma: [],
    score: [],
    beta,
    betaAssumed,
  };
  if (ticker === marksBenchmark) return result;
  const { T, B } = weightedSums(m);
  for (let k = 0; k < n; k++) {
    const mark = m.mark[k] ?? null;
    result.mark.push(mark);
    result.contribution.push(mark ? round4(m.tR[k]! - beta * m.bR[k]!) : null);
    const scorable = k >= m.spyFirst && k >= m.stockFirst;
    const sum = scorable ? T[k]! - beta * B[k]! : null;
    const s = scorable ? (sigma?.[k] ?? null) : null;
    result.sum.push(sum === null ? null : round4(sum));
    result.sigma.push(s);
    result.score.push(marksScore(sum, s));
  }
  return result;
}

/** End minute E of an alert: the alert bar's start minute minus `window`. */
export const alertEndMinute = (alertMinute: number, window: number) =>
  alertMinute - window;
