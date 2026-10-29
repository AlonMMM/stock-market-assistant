import { AlpacaFeed, type Timeframe } from "./alpaca.js";
import { tickerPattern, type Credentials } from "./backtest.js";
import type { RawBar } from "./bars.js";
import {
  coreClose,
  newYork,
  newYorkToUtc,
  previousSessions,
} from "./calendar.js";
import { defaultSipDelayMinutes, sipDelayMs } from "./sip-delay.js";
import { barAt, overnightEnd, type SessionPart } from "./sessions.js";

// Bars of one stock and its benchmark for the full-screen chart
// (docs/features/fullscreen-chart.md): one bar size, a run of sessions,
// regular hours only, split-adjusted. Each stock bar carries the session VWAP
// at its close and its volume against the same bar time over the previous 20
// sessions (the 20 days before, on 1D). Nothing is cached.

export type BarSize = "1m" | "5m" | "15m" | "1h" | "1D";

export const barSizes: Record<
  BarSize,
  {
    minutes: number; // bar length; 1D counts as one bar per session
    timeframe: Timeframe; // what is read from Alpaca (1h is two 30-minute bars)
    sessions: number; // sessions shown when the chart opens
    maxSessions: number; // most sessions one request may ask for
  }
> = {
  "1m": { minutes: 1, timeframe: "1Min", sessions: 2, maxSessions: 5 },
  "5m": { minutes: 5, timeframe: "5Min", sessions: 5, maxSessions: 20 },
  "15m": { minutes: 15, timeframe: "15Min", sessions: 10, maxSessions: 40 },
  "1h": { minutes: 60, timeframe: "30Min", sessions: 30, maxSessions: 120 },
  "1D": { minutes: 390, timeframe: "1Day", sessions: 250, maxSessions: 500 },
};

/** Sessions behind a bar's average volume and percentile; fewer than the minimum give null. */
export const volumeSessions = 20;
export const volumeMinimum = 15;
const open = 570; // 09:30 New York
const todayStep = 5; // minutes per step of today's volume so far

export interface Ohlcv {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ChartBarsRow {
  start: number; // bar start, Unix seconds (UTC); 1D: the session's New York midnight
  date: string; // New York session date
  // Part of the trading day; regular unless the chart asked for extended
  // hours (pre-market, after-hours, overnight). 1D: regular.
  session?: SessionPart;
  stock: Ohlcv;
  against: Ohlcv | null; // the benchmark's bar at the same time, if it traded
  // Last close of the previous session (1D: the previous day); null when unknown.
  previousClose: number | null;
  againstPreviousClose: number | null;
  // Session VWAP at the bar's close, from the session's first regular bar;
  // null on 1D.
  vwap: number | null;
  // Mean volume of this bar time over the previous 20 sessions (1D: the 20
  // days before) and the share of them with less volume, 0–100; null with
  // fewer than 15 sessions.
  averageVolume: number | null;
  volumePercentile: number | null;
}

/** The latest shown session's volume so far, against the same time of day. */
export interface TodayVolume {
  date: string;
  through: number; // Unix seconds: volume counts up to this New York time
  volume: number;
  averageVolume: number | null;
  percentile: number | null;
  sessions: number; // previous sessions compared
}

export interface ChartBars {
  ticker: string;
  against: string | null; // null when the stock is its own benchmark
  bar: BarSize;
  sessions: string[]; // New York session dates shown, oldest first
  rows: ChartBarsRow[];
  today: TodayVolume | null;
  delayMinutes: number;
  at: number; // when this was read (ms)
}

interface Slot extends Ohlcv {
  start: number;
  part: SessionPart;
  priceVolume: number; // Σ bar VWAP × volume, for the session VWAP
}

// Bars of one symbol by trading date, then by bar key (sessions.ts `barAt`;
// 0 for a daily bar). Regular hours only unless `extended`.
function group(
  rows: RawBar[],
  minutes: number,
  daily: boolean,
  extended = false,
): Map<string, Map<number, Slot>> {
  const days = new Map<string, Map<number, Slot>>();
  for (const r of rows) {
    let date: string;
    let key = 0;
    let start = r.start;
    let part: SessionPart = "regular";
    if (daily) date = newYork(r.start * 1000).date;
    else {
      const b = barAt(r.start * 1000, minutes);
      if (!b || (!extended && b.part !== "regular")) continue;
      ({ date, key, start, part } = b);
    }
    let day = days.get(date);
    if (!day) days.set(date, (day = new Map()));
    const price = r.vwap ?? (r.high + r.low + r.close) / 3;
    const s = day.get(key);
    if (!s)
      day.set(key, {
        start,
        part,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        priceVolume: price * r.volume,
      });
    else {
      s.high = Math.max(s.high, r.high);
      s.low = Math.min(s.low, r.low);
      s.close = r.close;
      s.volume += r.volume;
      s.priceVolume += price * r.volume;
    }
  }
  return days;
}

const ohlcv = (s: Slot): Ohlcv => ({
  open: s.open,
  high: s.high,
  low: s.low,
  close: s.close,
  volume: s.volume,
});

// The session's regular close: after-hours and overnight do not count.
const lastClose = (day: Map<number, Slot> | undefined): number | null => {
  const keys = [...(day ?? new Map<number, Slot>()).entries()]
    .filter(([, s]) => s.part === "regular")
    .map(([k]) => k);
  return keys.length ? day!.get(Math.max(...keys))!.close : null;
};

/** Mean and percentile (share of `past` below `value`, 0–100). */
export function volumeRank(
  value: number,
  past: number[],
): { average: number | null; percentile: number | null } {
  if (past.length < volumeMinimum) return { average: null, percentile: null };
  return {
    average: past.reduce((a, v) => a + v, 0) / past.length,
    percentile: Math.round(
      (past.filter((v) => v < value).length / past.length) * 100,
    ),
  };
}

const nextDay = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/**
 * `GET /api/bars?ticker=NVDA&against=SPY&bar=5m&sessions=5&end=2026-10-16`.
 * `extended=1` adds pre-market and after-hours bars, and the overnight
 * session from BOATS when the plan has it (intraday bars only).
 */
export async function handleChartBars(
  query: {
    ticker?: unknown;
    against?: unknown;
    bar?: unknown;
    sessions?: unknown;
    end?: unknown;
    extended?: unknown;
  },
  credentials: Credentials,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ status: number; body: ChartBars | { error: string } }> {
  if (!credentials.key || !credentials.secret)
    return {
      status: 503,
      body: { error: "Alpaca credentials are not configured on the server" },
    };
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const ticker = text(query.ticker).toUpperCase();
  const against = (text(query.against) || "SPY").toUpperCase();
  const bar = text(query.bar) as BarSize;
  const size = Object.hasOwn(barSizes, bar) ? barSizes[bar] : null;
  if (!tickerPattern.test(ticker) || !tickerPattern.test(against) || !size)
    return {
      status: 400,
      body: { error: "Give a ticker, a benchmark and a bar size" },
    };
  const sessions = text(query.sessions)
    ? Number(query.sessions)
    : size.sessions;
  if (
    !Number.isInteger(sessions) ||
    sessions < 1 ||
    sessions > size.maxSessions
  )
    return {
      status: 400,
      body: { error: `Ask for 1–${size.maxSessions} sessions of ${bar} bars` },
    };
  const daily = bar === "1D";
  const extended = !daily && text(query.extended) === "1";
  // Overnight bars come from Alpaca's BOATS feed (Algo Trader Plus).
  const overnight = extended;
  const delayMinutes = credentials.sipDelayMinutes ?? defaultSipDelayMinutes;
  const until = now - sipDelayMs(delayMinutes);
  const endDate = text(query.end);
  // The last session asked for, and the sessions before it: those shown plus
  // 20 for the volume comparison. Without `end`, one more in case today has
  // no bars yet (before the open).
  let last: string;
  let dates: string[];
  try {
    if (endDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || coreClose(endDate) === null)
        throw new Error("not a session");
      last = endDate;
    } else {
      const today = newYork(until).date;
      last = coreClose(today) !== null ? today : previousSessions(today, 1)[0]!;
    }
    dates = [
      ...previousSessions(last, sessions + volumeSessions + (endDate ? 0 : 1)),
      last,
    ];
  } catch {
    return {
      status: 400,
      body: { error: "Choose a 2024–2028 US trading day" },
    };
  }
  // The overnight after the last session runs to 04:00 of the next one.
  const end = Math.min(
    overnight ? overnightEnd(last) : Date.parse(`${nextDay(last)}T06:00:00Z`),
    until,
  );
  const iso = (date: string) => `${date}T00:00:00Z`;
  if (Date.parse(iso(dates[0]!)) >= end)
    return { status: 400, body: { error: "That day has no data yet" } };
  const endIso = new Date(end).toISOString();
  const feed = new AlpacaFeed(
    credentials.key,
    credentials.secret,
    "sip",
    () => {},
    fetcher,
  );
  const hasBench = against !== ticker;
  // The benchmark is only needed for the shown sessions and the one before.
  const benchFrom = dates[Math.max(0, dates.length - sessions - 2)]!;
  // Today's volume so far is always counted in 5-minute steps, so every bar
  // size shows the same number; 1m and 5m bars already hold it.
  const ownSteps = bar === "1m" || bar === "5m";
  const stepFrom = dates[Math.max(0, dates.length - volumeSessions - 2)]!;
  try {
    // Overnight bars for the shown sessions: a chart without them still
    // loads when the account or the feed cannot give them.
    const night = overnight
      ? new AlpacaFeed(
          credentials.key,
          credentials.secret,
          "boats",
          () => {},
          fetcher,
        )
      : null;
    const nightRows = (symbol: string) =>
      night
        ? night
            .history(symbol, iso(benchFrom), endIso, size.timeframe, "split")
            .catch(() => [])
        : Promise.resolve([]);
    const [stockRows, benchRows, stepRows, stockNight, benchNight] =
      await Promise.all([
        feed.history(ticker, iso(dates[0]!), endIso, size.timeframe, "split"),
        hasBench
          ? feed.history(
              against,
              iso(benchFrom),
              endIso,
              size.timeframe,
              "split",
            )
          : Promise.resolve([]),
        ownSteps
          ? Promise.resolve(null)
          : feed.history(ticker, iso(stepFrom), endIso, "5Min", "split"),
        nightRows(ticker),
        hasBench ? nightRows(against) : Promise.resolve([]),
      ]);
    const stock = group(
      [...stockRows, ...stockNight],
      size.minutes,
      daily,
      extended,
    );
    const bench = hasBench
      ? group([...benchRows, ...benchNight], size.minutes, daily, extended)
      : null;
    // Sessions without a stock bar drop out (today before the open).
    const traded = dates.filter((d) => stock.has(d));
    const shown = traded.slice(-sessions);
    const rows: ChartBarsRow[] = [];
    for (const date of shown) {
      const t = traded.indexOf(date);
      const previous = traded[t - 1];
      const history = traded.slice(Math.max(0, t - volumeSessions), t);
      const previousClose = previous ? lastClose(stock.get(previous)) : null;
      const againstPreviousClose =
        bench && previous ? lastClose(bench.get(previous)) : null;
      const day = stock.get(date)!;
      let priceVolume = 0;
      let volume = 0;
      for (const k of [...day.keys()].sort((a, b) => a - b)) {
        const s = day.get(k)!;
        const regular = s.part === "regular";
        // The session VWAP counts regular-hours trades only.
        if (regular) {
          priceVolume += s.priceVolume;
          volume += s.volume;
        }
        // A session that closed before this bar time (an early close) is
        // not compared; one that was open but had no trade counts as 0.
        const past = history
          .filter(
            (h) => daily || !regular || open + k * size.minutes < coreClose(h)!,
          )
          .map((h) => stock.get(h)?.get(k)?.volume ?? 0);
        const rank = volumeRank(s.volume, past);
        const b = bench?.get(date)?.get(k);
        rows.push({
          start: s.start,
          date,
          ...(extended ? { session: s.part } : {}),
          stock: ohlcv(s),
          against: b ? ohlcv(b) : null,
          previousClose,
          againstPreviousClose,
          vwap: daily || !regular || volume === 0 ? null : priceVolume / volume,
          averageVolume: rank.average,
          volumePercentile: rank.percentile,
        });
      }
    }
    return {
      status: 200,
      body: {
        ticker,
        against: hasBench ? against : null,
        bar,
        sessions: shown,
        rows,
        today: todayVolume(
          group(stepRows ?? stockRows, todayStep, false),
          shown.at(-1),
          until,
        ),
        delayMinutes,
        at: now,
      },
    };
  } catch (error) {
    return {
      status: 502,
      body: {
        error:
          error instanceof Error && error.message.startsWith("Alpaca")
            ? error.message
            : "Market data request failed",
      },
    };
  }
}

// Volume of `date` up to the last finished 5-minute step (the whole session
// once it closed), against the previous 20 sessions up to the same time.
function todayVolume(
  steps: Map<string, Map<number, Slot>>,
  date: string | undefined,
  until: number,
): TodayVolume | null {
  if (!date || !steps.has(date)) return null;
  const close = coreClose(date)!;
  const at = newYork(until);
  const minute = at.date === date ? Math.min(at.minute, close) : close;
  const count = Math.floor((minute - open) / todayStep);
  if (count <= 0) return null;
  const sum = (day: Map<number, Slot> | undefined) => {
    let total = 0;
    for (const [k, s] of day ?? []) if (k < count) total += s.volume;
    return total;
  };
  const history = [...steps.keys()]
    .filter((d) => d < date)
    .sort()
    .slice(-volumeSessions);
  const volume = sum(steps.get(date));
  const rank = volumeRank(
    volume,
    history.map((d) => sum(steps.get(d))),
  );
  return {
    date,
    through: newYorkToUtc(date, open + count * todayStep) / 1000,
    volume,
    averageVolume: rank.average,
    percentile: rank.percentile,
    sessions: history.length,
  };
}
