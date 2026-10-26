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

/** Keep the true time spacing while framing the dates that contain trades. */
export function tradeTimeDomain(
  times: number[],
  periodStart: number,
  periodEnd: number,
) {
  if (times.length === 0)
    return [periodStart, Math.max(periodEnd, periodStart + 60_000)] as const;

  const first = Math.min(...times);
  const last = Math.max(...times);
  const padding = Math.max(2 * hour, (last - first) * 0.08);
  return [first - padding, last + padding] as const;
}

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

/**
 * SVG path of a realized-value curve as steps (user 2026-10-26: "make it more
 * professional"): realized value only changes when a trade closes, so the
 * line runs flat from `startX` at the starting value, jumps at each close and
 * runs flat again to `endX`. Points must be sorted by x.
 */
export function stepPath(
  start: [number, number],
  points: [number, number][],
  endX: number,
): string {
  let path = `M ${start[0]} ${start[1]}`;
  for (const [x, y] of points) path += ` H ${x} V ${y}`;
  return `${path} H ${Math.max(endX, points.at(-1)?.[0] ?? start[0])}`;
}

const israelDayParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const israelParts = (ms: number) =>
  Object.fromEntries(
    israelDayParts.formatToParts(ms).map((p) => [p.type, p.value]),
  ) as Record<string, string>;

/** The instant of 00:00 Israel time on an Israel date ("2026-10-26"). */
export function israelMidnight(date: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`);
  // Israel is UTC+2 in winter and UTC+3 in summer.
  for (const hours of [2, 3]) {
    const at = wall - hours * 3_600_000;
    const p = israelParts(at);
    if (`${p.year}-${p.month}-${p.day}` === date && p.hour === "00") return at;
  }
  return wall - 2 * 3_600_000;
}

/**
 * Ticks at Israel midnights inside [start, end], every 1, 2, 7 or 14 days so
 * that at most `count` show. Each tick is that day's own midnight, so labels
 * stay right across a clock change (the old fixed offset named Monday "25 Oct"
 * after Israel's change on 2026-10-25).
 */
export function israelDayTicks(start: number, end: number, count = 5) {
  const p = israelParts(start);
  let date = `${p.year}-${p.month}-${p.day}`;
  const days: number[] = [];
  for (let guard = 0; guard < 800; guard++) {
    const at = israelMidnight(date);
    if (at > end) break;
    if (at >= start) days.push(at);
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    date = d.toISOString().slice(0, 10);
  }
  const every = [1, 2, 7, 14, 30].find((n) => days.length / n <= count) ?? 30;
  return days.filter((_, i) => i % every === 0);
}

/** The step between two neighbouring ticks (0 for fewer than two). */
export const tickStep = (ticks: number[]) =>
  ticks.length > 1 ? Math.abs(ticks[1]! - ticks[0]!) : 0;

/**
 * A dollar axis label as precise as the ticks' step needs, so no two ticks
 * read the same ("$99,500" and "$100,000", never "$100K" twice).
 */
export function moneyTick(value: number, step: number): string {
  const sign = value < 0 ? "−" : "";
  const a = Math.abs(value);
  if (step >= 1000 && step % 1000 === 0 && a >= 10000)
    return `${sign}$${(a / 1000).toLocaleString("en-US")}K`;
  return `${sign}$${a.toLocaleString("en-US", {
    minimumFractionDigits: step > 0 && step < 1 ? 2 : 0,
    maximumFractionDigits: step > 0 && step < 1 ? 2 : 0,
  })}`;
}

/** A percent axis label as precise as the ticks' step needs. */
export function percentTick(value: number, step: number): string {
  const digits = step > 0 && step < 0.1 ? 2 : step > 0 && step < 1 ? 1 : 0;
  return `${value < 0 ? "−" : value > 0 ? "+" : ""}${Math.abs(value).toFixed(digits)}%`;
}
