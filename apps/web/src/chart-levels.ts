// The trade chart's support and resistance (user 2026-11-02): the levels the
// bot already trades on (packages/trading/src/bot/levels.ts), as known on the
// trade's entry day: yesterday's high and low and the 5 sessions' high and
// low from the daily bars (regular hours), the first 15 minutes' high and low
// from the day's own minutes, and the day's high and low so far, minute by
// minute. Also the zoom buttons' range. No DOM access, so Node tests import it.
import type { ChartBarsRow } from "../../../packages/market-data/src/chart-bars.js";
import type {
  ChartBar,
  TradeChartSession,
} from "../../../packages/market-data/src/trade-chart.js";

export interface ChartLevel {
  title: string; // the price line's label
  price: number;
  side: "high" | "low"; // a high is resistance, a low support
}

// The first 15 minutes, as the bot's levels count them (from 09:45).
const openingMinutes = 15;

/** The entry day's levels, from the daily bars before it and the day's own minutes. */
export function tradeLevels(
  daily: readonly ChartBarsRow[] | null,
  entryDate: string,
  entryDay: TradeChartSession | null,
): ChartLevel[] {
  const out: ChartLevel[] = [];
  const before = (daily ?? []).filter((r) => r.date < entryDate);
  const yesterday = before.at(-1);
  if (yesterday) {
    out.push({ title: "Yday high", price: yesterday.stock.high, side: "high" });
    out.push({ title: "Yday low", price: yesterday.stock.low, side: "low" });
  }
  const five = before.slice(-5);
  if (five.length === 5) {
    const high = Math.max(...five.map((r) => r.stock.high));
    const low = Math.min(...five.map((r) => r.stock.low));
    out.push({ title: "5-day high", price: high, side: "high" });
    out.push({ title: "5-day low", price: low, side: "low" });
  }
  const opening = (entryDay?.stock ?? []).filter(([m]) => m < openingMinutes);
  if (opening.length > 0) {
    const high = Math.max(...opening.map((b) => b[2]));
    const low = Math.min(...opening.map((b) => b[3]));
    out.push({ title: "15-min high", price: high, side: "high" });
    out.push({ title: "15-min low", price: low, side: "low" });
  }
  return out;
}

/** The day's high and low so far at each minute: [minute, high, low]. */
export function dayRange(
  bars: readonly ChartBar[],
): [number, number, number][] {
  const out: [number, number, number][] = [];
  let high = -Infinity;
  let low = Infinity;
  for (const [m, , h, l] of bars) {
    high = Math.max(high, h);
    low = Math.min(low, l);
    out.push([m, high, low]);
  }
  return out;
}

// The zoom buttons: each press halves or doubles the bars shown, around the
// middle of the view; never fewer than this many bars.
const fewestBars = 10;

/** The visible range after one zoom step: `factor` < 1 zooms in, > 1 out. */
export function zoomRange(
  range: { from: number; to: number },
  factor: number,
): { from: number; to: number } {
  const middle = (range.from + range.to) / 2;
  const half = Math.max(fewestBars / 2, ((range.to - range.from) / 2) * factor);
  return { from: middle - half, to: middle + half };
}
