import type { AlertEvent } from "../../alerts/src/events.js";
import type { PriceBar, RawBar } from "../../market-data/src/bars.js";
import { betaReturns, dailyBeta } from "../../market-data/src/beta.js";
import { newYork } from "../../market-data/src/calendar.js";
import {
  excessPercent,
  excessSigma,
  rsScore,
} from "../../market-data/src/rs-score.js";

// Relative strength of an alerted stock against SPY and its sector benchmark
// (user-confirmed 2026-09-28). All returns are percent.
//   excess = r_stock − β·r_benchmark
//   relation (day horizon): against | independent | with | outperform
//   score = clamp(50 + 10 · excess_day / σ, 0, 100), σ = stdev of the
//   stock's daily excess over the 20 sessions before the alert day.
// The score and σ come from the shared rs-score module (also used by the day
// chart and the board), so both always agree for the same inputs.
export { sigmaReturns } from "../../market-data/src/rs-score.js";
export const flatBenchmarkPercent = 0.3;
export const explainedShare = 0.5;

export type Relation = "against" | "independent" | "with" | "outperform";

export interface Horizon {
  stock: number;
  benchmark: number;
  excess: number;
  // Bar ends the benchmark change was measured between (evidence).
  benchmarkFrom: string;
  benchmarkTo: string;
}

export interface BenchmarkScore {
  benchmark: string;
  kind: "market" | "sector";
  beta: number;
  // True when β could not be estimated and 1 was used.
  betaAssumed: boolean;
  betaReturns: number;
  // The alert window: same start close as the alert's own move.
  window: Horizon | null;
  // Previous regular close → alert bar close.
  day: Horizon | null;
  relation: Relation | null;
  sigma: number | null;
  score: number | null;
}

export interface ScoreInput {
  alert: AlertEvent;
  // Previous session and the alert day up to the alert bar, minute bars.
  stockBars: PriceBar[];
  benchmark: string;
  kind: "market" | "sector";
  benchmarkBars: PriceBar[];
  // Split-adjusted daily bars for the sessions before the alert day only.
  stockDaily: RawBar[];
  benchmarkDaily: RawBar[];
  // Consecutive sessions before the alert day, oldest first.
  sessions: string[];
  previous: string; // the session before the alert day
}

const change = (from: number, to: number) => (to / from - 1) * 100;

function lastAtOrBefore(bars: PriceBar[], date: string, end: number) {
  let found: PriceBar | undefined;
  for (const bar of bars)
    if (bar.date === date && Date.parse(bar.end) <= end) found = bar;
  return found;
}

function previousClose(bars: PriceBar[], previous: string) {
  let close: PriceBar | undefined;
  for (const bar of bars)
    if (bar.date === previous && bar.session === "regular") close = bar;
  return close;
}

export function relation(
  stock: number,
  benchmark: number,
  beta: number,
): Relation {
  if (Math.abs(benchmark) < flatBenchmarkPercent) return "independent";
  if (stock * benchmark < 0) return "against";
  return Math.abs(beta * benchmark) >= explainedShare * Math.abs(stock)
    ? "with"
    : "outperform";
}

/** Scores one alert against one benchmark; missing data yields nulls. */
export function scoreAgainst(input: ScoreInput): BenchmarkScore {
  const { alert, benchmarkBars } = input;
  const end = Date.parse(alert.end);
  // The alert bar started one minute before its end.
  const date = newYork(end - 60000).date;
  // 60-session beta, as on the day chart.
  const estimated = dailyBeta(
    input.sessions.slice(-(betaReturns + 1)),
    input.stockDaily,
    input.benchmarkDaily,
  );
  const beta = estimated.value ?? 1;
  const horizon = (
    stock: number | null,
    from: PriceBar | undefined,
    to: PriceBar | undefined,
  ): Horizon | null => {
    if (stock === null || !from || !to || to.end <= from.end) return null;
    const benchmark = change(from.close, to.close);
    return {
      stock,
      benchmark,
      excess: excessPercent(stock, benchmark, beta),
      benchmarkFrom: from.end,
      benchmarkTo: to.end,
    };
  };
  const benchmarkNow = lastAtOrBefore(benchmarkBars, date, end);
  const window = horizon(
    alert.move,
    lastAtOrBefore(benchmarkBars, date, end - alert.config.window * 60000),
    benchmarkNow,
  );
  const stockBase = previousClose(input.stockBars, input.previous);
  const stockNow =
    alert.close ?? lastAtOrBefore(input.stockBars, date, end)?.close;
  const day = horizon(
    stockBase && stockNow !== undefined
      ? change(stockBase.close, stockNow)
      : null,
    previousClose(benchmarkBars, input.previous),
    benchmarkNow,
  );
  const sigma = excessSigma(
    input.sessions,
    input.stockDaily,
    input.benchmarkDaily,
    beta,
  );
  return {
    benchmark: input.benchmark,
    kind: input.kind,
    beta,
    betaAssumed: estimated.value === null,
    betaReturns: estimated.returns,
    window,
    day,
    relation: day ? relation(day.stock, day.benchmark, beta) : null,
    sigma,
    score: rsScore(day?.excess, sigma),
  };
}
