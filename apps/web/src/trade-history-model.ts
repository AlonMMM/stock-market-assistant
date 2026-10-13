import type { ClosedTrade } from "../../../packages/trading/src/portfolio.js";

/** Sum dollars first; trade percentage returns cannot be added together. */
export function cumulativeTrades(
  trades: ClosedTrade[],
  baseEquity: number | null,
) {
  let total = 0;
  return [...trades]
    .sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt))
    .map((trade) => {
      total += trade.pnl;
      const pnl = Math.round(total * 100) / 100;
      return {
        trade,
        time: Date.parse(trade.closedAt),
        pnl,
        pct:
          baseEquity !== null && baseEquity > 0
            ? (pnl / baseEquity) * 100
            : null,
      };
    });
}

/** Round axis values (1, 2, 2.5 or 5 × 10ⁿ) that cover [low, high]. */
export function niceTicks(low: number, high: number, count = 5) {
  if (!(high > low)) {
    const pad = Math.abs(low) > 0 ? Math.abs(low) * 0.5 : 1;
    return niceTicks(low - pad, high + pad, count);
  }
  const rough = (high - low) / Math.max(1, count - 1);
  const power = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ??
    10 * power;
  const first = Math.floor(low / step) * step;
  const ticks: number[] = [];
  for (let t = first; t < high + step * 0.999; t += step)
    ticks.push(Math.round(t / step) * step);
  // Avoid "-0" labels and floating-point noise such as 0.30000000000000004.
  return ticks.map((t) => Number((t === 0 ? 0 : t).toPrecision(12)));
}

const hour = 3_600_000;
const timeSteps = [
  hour,
  3 * hour,
  6 * hour,
  12 * hour,
  24 * hour,
  2 * 24 * hour,
  3 * 24 * hour,
  5 * 24 * hour,
  7 * 24 * hour,
  14 * 24 * hour,
  30 * 24 * hour,
  91 * 24 * hour,
];

/**
 * Evenly spaced time-axis ticks inside [start, end]. `daily` says whether the
 * step is a day or more, so labels can drop the clock.
 */
export function timeTicks(start: number, end: number, count = 5, offset = 0) {
  const rough = (end - start) / Math.max(1, count);
  const step = timeSteps.find((s) => s >= rough) ?? timeSteps.at(-1)!;
  const ticks: number[] = [];
  // `offset` (local wall clock − UTC) aligns day ticks to local midnight.
  for (
    let t = Math.ceil((start + offset) / step) * step - offset;
    t <= end;
    t += step
  )
    ticks.push(t);
  return { ticks, daily: step >= 24 * hour };
}

/** Index of the point whose time is closest to `time`; -1 when empty. */
export function nearestPoint(times: number[], time: number) {
  let best = -1;
  let distance = Infinity;
  times.forEach((t, i) => {
    if (Math.abs(t - time) < distance) {
      distance = Math.abs(t - time);
      best = i;
    }
  });
  return best;
}
