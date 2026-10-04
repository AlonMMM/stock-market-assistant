// Day-based relative-strength score against a benchmark (user-confirmed
// 2026-09-28; docs/features/chart-vs-spy.md, "Semantics"). The alert
// analysis keeps it; alerts, the board and the day chart now use the area
// score (area-vs-spy.ts, docs/features/area-vs-spy.md).
//   excess = r_stock − β · r_benchmark          (all percent)
//   σ      = sample stdev of the stock's daily excess (close-to-close, same β)
//            over the 20 sessions before the scored day; ≥ 15 needed
//   score  = round(clamp(50 + 10 · excess / σ, 0, 100))
import type { RawBar } from "./bars.js";
import { betaReturns, dailyBeta, dailyCloses } from "./beta.js";
import type { ChartBar, ChartSeries } from "./day-chart.js";

export const sigmaReturns = 20;
export const sigmaMinimumReturns = 15;

const change = (from: number, to: number) => (to / from - 1) * 100;

/** Score 0–100 from an excess move (%) and σ (%); null without both. */
export function rsScore(
  excessPct: number | null | undefined,
  sigma: number | null | undefined,
): number | null {
  if (
    excessPct === null ||
    excessPct === undefined ||
    !Number.isFinite(excessPct) ||
    sigma === null ||
    sigma === undefined ||
    !(sigma > 0)
  )
    return null;
  return Math.round(Math.min(100, Math.max(0, 50 + (10 * excessPct) / sigma)));
}

/** excess = r_stock − β · r_benchmark, percent. */
export const excessPercent = (stock: number, benchmark: number, beta: number) =>
  stock - beta * benchmark;

export function sampleDeviation(values: number[]): number {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * σ of the stock's daily excess over the last `sigmaReturns` returns of
 * `sessions` (consecutive sessions before the scored day, oldest first);
 * a return counts only when both symbols have both closes. Null with fewer
 * than `sigmaMinimumReturns` returns or zero spread.
 */
export function excessSigma(
  sessions: string[],
  stockDaily: RawBar[],
  benchmarkDaily: RawBar[],
  beta: number,
): number | null {
  const a = dailyCloses(stockDaily);
  const m = dailyCloses(benchmarkDaily);
  const recent = sessions.slice(-(sigmaReturns + 1));
  const excess: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const [p, d] = [recent[i - 1]!, recent[i]!];
    const [a0, a1, m0, m1] = [a.get(p), a.get(d), m.get(p), m.get(d)];
    if (a0 && a1 && m0 && m1)
      excess.push(excessPercent(change(a0, a1), change(m0, m1), beta));
  }
  if (excess.length < sigmaMinimumReturns) return null;
  const sigma = sampleDeviation(excess);
  return sigma > 0 ? sigma : null;
}

/** β and σ of one stock against SPY, as used by the day chart and board. */
export interface SpyStrength {
  // 60-session daily β vs SPY; 1 when it cannot be estimated.
  beta: number;
  betaAssumed: boolean;
  betaReturns: number; // paired daily returns behind β
  sigma: number | null; // % (daily excess σ); null → no score
}

/**
 * β/σ from split-adjusted daily bars of the stock and SPY. `sessions` are the
 * `betaReturns + 1` consecutive sessions before the scored day, oldest first;
 * bars on or after the scored day must not be passed (no look-ahead).
 */
export function spyStrength(
  sessions: string[],
  stockDaily: RawBar[],
  spyDaily: RawBar[],
): SpyStrength {
  const estimated = dailyBeta(
    sessions.slice(-(betaReturns + 1)),
    stockDaily,
    spyDaily,
  );
  const beta = estimated.value ?? 1;
  return {
    beta,
    betaAssumed: estimated.value === null,
    betaReturns: estimated.returns,
    sigma: excessSigma(sessions, stockDaily, spyDaily, beta),
  };
}

/**
 * @deprecated The day chart's score is the area score (`DayChart.areaVsSpy`);
 * kept until the web stops calling it.
 *
 * Score per bar of `stock` (aligned with `stock.bars`) against `spy`: both %
 * from each series' previous regular close to the bar's close; SPY's close is
 * its latest bar starting at or before the stock bar. Null where either base
 * or SPY bar is missing, or σ is unavailable.
 */
export function scoreSeries(
  stock: Pick<ChartSeries, "previousClose" | "bars">,
  spy: Pick<ChartSeries, "previousClose" | "bars">,
  strength: Pick<SpyStrength, "beta" | "sigma">,
): (number | null)[] {
  const spyBars: ChartBar[] = [...spy.bars].sort((x, y) => x.start - y.start);
  let j = -1;
  return stock.bars.map((bar) => {
    while (j + 1 < spyBars.length && spyBars[j + 1]!.start <= bar.start) j++;
    if (!stock.previousClose || !spy.previousClose || j < 0) return null;
    return rsScore(
      excessPercent(
        change(stock.previousClose, bar.close),
        change(spy.previousClose, spyBars[j]!.close),
        strength.beta,
      ),
      strength.sigma,
    );
  });
}
