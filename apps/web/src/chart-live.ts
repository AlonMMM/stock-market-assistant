// Live prices on the charts (user 2026-10-19: the watchlist every second,
// "also the full screen and the charts"). Each chart keeps reading its bars as
// before; the latest trade, read every second, is applied on top as the
// forming bar. Nothing here is sent anywhere or stored.
import type {
  ChartBarsRow,
  BarSize,
} from "../../../packages/market-data/src/chart-bars.js";
import { barSizes } from "../../../packages/market-data/src/chart-bars.js";
import type {
  Candle,
  Candles,
} from "../../../packages/market-data/src/candles.js";
import { newYorkToUtc } from "../../../packages/market-data/src/calendar.js";
import {
  barAt,
  sessionAt,
} from "../../../packages/market-data/src/sessions.js";

export interface Trade {
  price: number;
  at: number; // Unix ms
}

/**
 * The trading date and part of the day a moment belongs to: pre-market,
 * regular, after-hours, or the overnight after it (sessions.ts); null when
 * nothing trades.
 */
export const sessionOf = sessionAt;

/** Whether a chart of `date` can still change now (its session is trading). */
export const chartTrading = (date: string, now = Date.now()) =>
  sessionOf(now)?.date === date;

/**
 * The bar the latest trades are forming, kept in the browser between reads of
 * the chart: the first trade of its time slot opens it, later ones move its
 * high, low and close.
 */
export interface Running {
  start: number; // the slot's start, Unix s
  open: number;
  high: number;
  low: number;
  close: number;
  at: number; // the newest trade in it, Unix ms
}

/** `run` with `trade` added; `start` is the slot the trade falls in. */
export function advance(
  run: Running | null,
  trade: Trade,
  start: number,
): Running {
  if (!run || start > run.start)
    return {
      start,
      open: trade.price,
      high: trade.price,
      low: trade.price,
      close: trade.price,
      at: trade.at,
    };
  if (start < run.start || trade.at < run.at) return run;
  return {
    ...run,
    high: Math.max(run.high, trade.price),
    low: Math.min(run.low, trade.price),
    close: trade.price,
    at: trade.at,
  };
}

/** The one-minute slot of a trade in any part of a trading day. */
export const minuteSlot = (at: number) =>
  sessionOf(at) ? Math.floor(at / 60000) * 60 : null;

/**
 * The full-screen bar a trade falls in (sessions.ts `barAt`); with
 * `extended` off, regular hours only. 1D: today's bar, regular hours only.
 */
export function barSlot(
  bar: BarSize,
  at: number,
  extended = true,
): number | null {
  const s = sessionOf(at);
  if (!s) return null;
  if (bar === "1D")
    // Daily bars start at New York midnight, like the server's rows.
    return s.part === "regular" ? newYorkToUtc(s.date, 0) / 1000 : null;
  const b = barAt(at, barSizes[bar].minutes);
  return b && (extended || b.part === "regular") ? b.start : null;
}

// The server's bar for a slot, with what the running bar adds to it.
const merge = <T extends { high: number; low: number; close: number }>(
  bar: T,
  run: Running,
): T => ({
  ...bar,
  high: Math.max(bar.high, run.high),
  low: Math.min(bar.low, run.low),
  close: run.close,
});

const fresh = (run: Running) => ({
  open: run.open,
  high: run.high,
  low: run.low,
  close: run.close,
  volume: 0,
});

/**
 * One-minute candles with the running bar applied: merged into the server's
 * candle of its minute, or added after the last one, and `last` follows it.
 * A bar older than the last candle, or from another session, is ignored.
 */
export function withLiveCandles(data: Candles, run: Running | null): Candles {
  const s = run && sessionOf(run.at);
  if (!run || !s || s.date !== data.date) return data;
  if (data.last && run.at < data.last.at) return data;
  const tail = data.candles.at(-1);
  const last = { price: run.close, at: run.at };
  if (tail && run.start < tail.start) return { ...data, last };
  const candles: Candle[] =
    tail && run.start === tail.start
      ? [...data.candles.slice(0, -1), merge(tail, run)]
      : [...data.candles, { start: run.start, session: s.part, ...fresh(run) }];
  return { ...data, candles, last };
}

/**
 * Full-screen rows with the stock's and the benchmark's running bars applied,
 * slots from `barSlot`. A new intraday bar is added after the last row of
 * the same session; 1D only moves today's row.
 */
export function withLiveRows(
  rows: ChartBarsRow[],
  bar: BarSize,
  stock: Running | null,
  against: Running | null,
): ChartBarsRow[] {
  const tail = rows.at(-1);
  const s = stock && sessionOf(stock.at);
  if (!tail || !stock || !s || s.date !== tail.date) return rows;
  if (stock.start < tail.start) return rows;
  const bench = against && against.start === stock.start ? against : null;
  if (stock.start === tail.start)
    return [
      ...rows.slice(0, -1),
      {
        ...tail,
        stock: merge(tail.stock, stock),
        against: bench
          ? tail.against
            ? merge(tail.against, bench)
            : fresh(bench)
          : tail.against,
      },
    ];
  if (bar === "1D") return rows;
  return [
    ...rows,
    {
      start: stock.start,
      date: s.date,
      session: s.part,
      stock: fresh(stock),
      against: bench ? fresh(bench) : null,
      previousClose: tail.previousClose,
      againstPreviousClose: tail.againstPreviousClose,
      vwap: null,
      averageVolume: null,
      volumePercentile: null,
    },
  ];
}
