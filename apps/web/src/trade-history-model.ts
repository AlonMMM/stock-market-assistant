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

const dayName = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  weekday: "short",
  day: "numeric",
  month: "short",
});

export interface DayLabel {
  x: number;
  text: string; // "Fri 23 Oct", the Israel date
  anchor: "start" | "middle" | "end";
}

/**
 * The day names under a line drawn trade by trade (user 2026-10-26, option A
 * of the chart options): one per Israel date, centred under that day's trades,
 * kept inside `[0, width]` and dropped where it would overlap the one before;
 * the last day always shows.
 */
export function dayLabels(
  xs: number[],
  times: number[],
  width: number,
  minGap = 78,
): DayLabel[] {
  const groups: { text: string; xs: number[] }[] = [];
  times.forEach((t, i) => {
    const text = dayName.format(t);
    const last = groups.at(-1);
    if (last && last.text === text) last.xs.push(xs[i]!);
    else groups.push({ text, xs: [xs[i]!] });
  });
  const half = minGap / 2;
  const placed = groups.map((g): DayLabel => {
    const x = (Math.min(...g.xs) + Math.max(...g.xs)) / 2;
    return x < half
      ? { x: Math.max(0, Math.min(...g.xs)), text: g.text, anchor: "start" }
      : x > width - half
        ? { x: Math.min(width, Math.max(...g.xs)), text: g.text, anchor: "end" }
        : { x, text: g.text, anchor: "middle" };
  });
  const centre = (l: DayLabel) =>
    l.anchor === "start" ? l.x + half : l.anchor === "end" ? l.x - half : l.x;
  const out: DayLabel[] = [];
  placed.forEach((l, i) => {
    const prev = out.at(-1);
    if (!prev || centre(l) - centre(prev) >= minGap) out.push(l);
    else if (i === placed.length - 1) out[out.length - 1] = l;
  });
  return out;
}
