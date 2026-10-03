// SYNTHETIC market data for the alert-analysis tests.
import type { AlertEvent } from "../packages/alerts/src/events.js";
import { defaults } from "../packages/alerts/src/relative-volume.js";
import {
  normalize,
  type PriceBar,
  type RawBar,
} from "../packages/market-data/src/bars.js";
import {
  newYorkToUtc,
  previousSessions,
} from "../packages/market-data/src/calendar.js";

export const day = "2026-09-28";
export const sessions = previousSessions(day, 125);
export const previous = sessions.at(-1)!;
// The alert bar starts 10:29 New York time and ends 10:30.
export const alertEnd = new Date(newYorkToUtc(day, 630)).toISOString();

export function minuteBar(
  ticker: string,
  date: string,
  startMinute: number,
  close: number,
  volume = 1000,
): PriceBar {
  const raw: RawBar = {
    start: newYorkToUtc(date, startMinute) / 1000,
    open: close,
    high: close,
    low: close,
    close,
    volume,
  };
  return normalize(ticker, raw, "shares")!;
}

// Previous regular close, then today's bars at the given start minutes.
export function dayBars(
  ticker: string,
  previousClose: number,
  today: [number, number][],
): PriceBar[] {
  return [
    minuteBar(ticker, previous, 959, previousClose),
    ...today.map(([minute, close]) => minuteBar(ticker, day, minute, close)),
  ];
}

// Daily closes built from exact returns, one per session in `dates`.
export function dailyBars(dates: string[], returns: number[], start = 100) {
  let close = start;
  return dates.map((date, i) => {
    if (i > 0) close *= 1 + returns[i - 1]!;
    return {
      start: newYorkToUtc(date, 570) / 1000,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1e6,
    };
  });
}

// Benchmark ±1% alternating; the stock is 1.5× plus noise uncorrelated with
// it over every 4 sessions, so β is exactly 1.5 and the excess is ±noise.
export function pairedDaily(noise: number, dates = sessions) {
  const n = dates.length - 1;
  const market = Array.from({ length: n }, (_, i) => (i % 2 ? -0.01 : 0.01));
  const e = [noise, noise, -noise, -noise];
  const stock = market.map((r, i) => 1.5 * r + e[i % 4]!);
  return {
    stock: dailyBars(dates, stock),
    benchmark: dailyBars(dates, market, 500),
  };
}

export const alert = (overrides: Partial<AlertEvent> = {}): AlertEvent => ({
  ticker: "AAPL",
  end: alertEnd,
  session: "regular",
  actual: 50000,
  expected: 10000,
  ratio: 5,
  paceRatio: null,
  volumeBasis: "history",
  move: 1,
  expectedMove: 0.2,
  direction: "up",
  samples: 20,
  status: "alert",
  rule: "rvol-v4",
  config: defaults,
  close: 102,
  ...overrides,
});
