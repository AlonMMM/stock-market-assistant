// Pure view logic for the full-screen chart (docs/features/fullscreen-chart.md):
// the bars request, merging pages, chart times, session lines, the alert band,
// the volume chip and the legend lines. No DOM access, so Node tests import it.
import {
  barSizes,
  type BarSize,
  type ChartBarsRow,
  type Ohlcv,
  type TodayVolume,
} from "../../../packages/market-data/src/chart-bars.js";
import { israelWallSeconds } from "./time.js";

export { barSizes };
export type { BarSize, ChartBarsRow, Ohlcv, TodayVolume };

export const barOrder: BarSize[] = ["1m", "5m", "15m", "1h", "1D"];

/** What a bar size shows when it opens, for the top bar. */
export function rangeText(bar: BarSize): string {
  if (bar === "1m") return "yesterday and today";
  if (bar === "1D") return "last 12 months";
  return `last ${barSizes[bar].sessions} sessions`;
}

/** `/api/bars` query; `end` pins the last session shown (older pages, past days). */
export function barsUrl(
  ticker: string,
  against: string,
  bar: BarSize,
  end?: string,
): string {
  const query = new URLSearchParams({ ticker, against, bar });
  if (end) query.set("end", end);
  return `/api/bars?${query}`;
}

/** Rows of both lists by bar start; a newer read replaces the same bar. */
export function mergeRows(
  rows: ChartBarsRow[],
  incoming: ChartBarsRow[],
): ChartBarsRow[] {
  const byStart = new Map(rows.map((r) => [r.start, r]));
  for (const r of incoming) byStart.set(r.start, r);
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

/**
 * Chart time of a row: its start on the Israel wall clock (the library draws
 * UTC), or the session date at midnight for daily bars.
 */
export function chartTime(row: ChartBarsRow, bar: BarSize): number {
  return bar === "1D"
    ? Date.parse(`${row.date}T00:00:00Z`) / 1000
    : israelWallSeconds(row.start);
}

/** Indices where a session starts (a month, on 1D): the dashed lines. */
export function sessionStarts(rows: ChartBarsRow[], bar: BarSize): number[] {
  const key = (r: ChartBarsRow) => (bar === "1D" ? r.date.slice(0, 7) : r.date);
  const out: number[] = [];
  rows.forEach((r, i) => {
    if (i > 0 && key(r) !== key(rows[i - 1]!)) out.push(i);
  });
  return out;
}

/**
 * Indices of the bars that overlap an alert's window (the `windowMinutes`
 * before `alertEnd`). Only on 1m and 5m, where the window is wider than a bar.
 */
export function alertBars(
  rows: ChartBarsRow[],
  bar: BarSize,
  alertEnd: string | undefined,
  windowMinutes: number,
): number[] {
  const end = alertEnd ? Date.parse(alertEnd) / 1000 : NaN;
  if (Number.isNaN(end) || (bar !== "1m" && bar !== "5m")) return [];
  const start = end - Math.max(1, windowMinutes) * 60;
  const length = barSizes[bar].minutes * 60;
  const out: number[] = [];
  rows.forEach((r, i) => {
    if (r.start < end && r.start + length > start) out.push(i);
  });
  return out;
}

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
/** "38.4M", "912K". */
export const compactVolume = (v: number) => compact.format(v);

/** "85th", "1st", "12th". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** "+2.31%", "−0.40%" (a real minus); null without a base. */
export function signedChange(
  value: number,
  base: number | null | undefined,
): string | null {
  if (!base) return null;
  const p = (value / base - 1) * 100;
  return `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(2)}%`;
}

/** Top-bar chip: today's volume so far against the same time of day. */
export function volumeChip(
  today: TodayVolume | null,
  label: (unixSeconds: number) => string,
): { text: string; title: string } | null {
  if (!today) return null;
  const by = label(today.through);
  if (today.averageVolume === null || today.percentile === null)
    return {
      text: `Vol ${compactVolume(today.volume)} · — avg`,
      title: `Volume by ${by}; fewer than 15 earlier sessions to compare with`,
    };
  const higher = Math.round((today.percentile / 100) * today.sessions);
  return {
    text: `Vol ${compactVolume(today.volume)} · ${(today.volume / today.averageVolume).toFixed(1)}× avg · ${ordinal(today.percentile)} pct`,
    title: `Volume by ${by} against the average by the same time over the last ${today.sessions} sessions; higher than ${higher} of them`,
  };
}

/** "NVDA · 5m · O 131.20  H 131.62  L 130.98  C 131.40". */
export function legendLine(symbol: string, bar: BarSize, b: Ohlcv): string {
  const f = (v: number) => v.toFixed(2);
  return `${symbol} · ${bar} · O ${f(b.open)}  H ${f(b.high)}  L ${f(b.low)}  C ${f(b.close)}`;
}

/** "VWAP 131.20 · NVDA above by 0.32%". */
export function vwapLine(ticker: string, close: number, vwap: number): string {
  const p = (close / vwap - 1) * 100;
  return `VWAP ${vwap.toFixed(2)} · ${ticker} ${p >= 0 ? "above" : "below"} by ${Math.abs(p).toFixed(2)}%`;
}
