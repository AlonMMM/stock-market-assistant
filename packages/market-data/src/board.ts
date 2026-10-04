import { AlpacaFeed } from "./alpaca.js";
import { sipDelay, type Credentials } from "./backtest.js";
import { normalize, type RawBar } from "./bars.js";
import type { D1Like } from "./bar-cache.js";
import { benchmark, betaReturns } from "./beta.js";
import {
  coreClose,
  newYork,
  newYorkToUtc,
  previousSessions,
} from "./calendar.js";
import {
  excessPercent,
  rsScore,
  spyStrength,
  type SpyStrength,
} from "./rs-score.js";
import {
  baselineSessions,
  baselineStep,
  D1DailyStore,
  typicalAt,
  volumeCurve,
  type BaselineStore,
  type DailyStore,
  type VolumeCurve,
} from "./volume-baseline.js";

// Nasdaq-100 proxy: Alpaca serves stocks and ETFs, not index values.
export const nasdaq = "QQQ";
export const maxBoardSymbols = 200;

export interface BoardStats {
  asOf: number; // Unix s, end of the newest bar used
  dayLow: number | null; // today's low/high, pre-market included
  dayHigh: number | null;
  volume: number; // regular-session cumulative volume to asOf
  // Median of the same cumulative volume to the same New York minute over the
  // previous 20 sessions; null with fewer than 15 such sessions.
  typicalVolume: number | null;
  relVolume: number | null; // volume / typicalVolume; null before the open
  // Score vs SPY (0–100) at asOf: % from previousClose to the latest bar
  // closing by asOf, for the stock and SPY (docs/features/chart-vs-spy.md);
  // null without σ, a base or a bar. Always against SPY.
  rsScore?: number | null;
  // 60-session daily β vs SPY; null when it cannot be estimated (the score
  // then uses β = 1, "β assumed").
  beta?: number | null;
}

export interface BoardSeries {
  ticker: string;
  previousClose: number | null; // previous session's daily close
  points: [number, number][]; // [bar start (Unix s), close], 5-minute bars
  stats?: BoardStats; // watchlist symbols only
}

export interface Board {
  source: "alpaca";
  feed: "sip";
  date: string; // US session shown: today once pre-market data exists
  // Regular session open and close (Unix s), from the exchange calendar.
  open: number;
  close: number;
  watchlist: string[]; // symbols to show as the board, in watchlist order
  benchmarks: Record<string, string>; // sector benchmark per listed symbol
  series: BoardSeries[]; // watchlist order, then SPY and QQQ if not listed
}

export type MultiHistory = (
  tickers: string[],
  start: string,
  end: string,
  timeframe: "5Min" | "1Day",
  adjustment?: "raw" | "split",
) => Promise<Map<string, RawBar[]>>;

/** β/σ vs SPY per symbol and board date, computed once per day. */
export type StrengthStore = DailyStore<SpyStrength>;

/** D1 store (the bar-cache database) for β/σ vs SPY. */
export class D1StrengthStore extends D1DailyStore<SpyStrength> {
  constructor(db: D1Like) {
    super(db, "spy_strength", "strength");
  }
}

/** Latest US session with (15-minute delayed) data at `now`. */
export function latestSession(now: number): string {
  const { date, minute } = newYork(now - sipDelay);
  // Pre-market data starts 04:00 New York time.
  if (coreClose(date) !== null && minute >= 240) return date;
  return previousSessions(date, 1)[0]!;
}

/**
 * Typical-volume curves for `tickers` on board date `date`: stored curves
 * first, then one 5-minute request per previous session's regular hours (in
 * parallel) for the rest, which are stored. Failures return no curve, so the
 * board still loads with Rel vol unavailable.
 */
async function baselines(
  tickers: string[],
  date: string,
  multi: MultiHistory,
  store?: BaselineStore,
): Promise<Map<string, VolumeCurve>> {
  let curves = new Map<string, VolumeCurve>();
  if (!tickers.length) return curves;
  try {
    if (store) curves = await store.get(date, tickers);
  } catch {
    // Degrade to fetching; the result stays correct.
  }
  const missing = tickers.filter((t) => !curves.has(t));
  if (!missing.length) return curves;
  let sessions: string[];
  try {
    sessions = previousSessions(date, baselineSessions);
  } catch {
    return curves; // outside calendar coverage: Rel vol unavailable
  }
  try {
    const days = await Promise.all(
      sessions.map((d) =>
        multi(
          missing,
          new Date(newYorkToUtc(d, 570)).toISOString(),
          new Date(newYorkToUtc(d, coreClose(d)!)).toISOString(),
          "5Min",
        ),
      ),
    );
    const fresh = new Map(
      missing.map((t) => [
        t,
        volumeCurve(
          days.flatMap((day) => day.get(t) ?? []),
          sessions,
        ),
      ]),
    );
    for (const [t, curve] of fresh) curves.set(t, curve);
    try {
      await store?.put(date, fresh);
    } catch {
      // Not stored this time; recomputed on the next poll.
    }
  } catch {
    // History unavailable: today's stats are still reported.
  }
  return curves;
}

/**
 * β/σ vs SPY for `tickers` on board date `date` (docs/features/chart-vs-spy.md):
 * stored values first, then one split-adjusted daily request for the rest and
 * SPY over the 61 sessions before the date, which is stored. Failures return
 * no values (score and β null) and are not stored.
 */
export async function strengths(
  tickers: string[],
  date: string,
  multi: MultiHistory,
  store?: StrengthStore,
): Promise<Map<string, SpyStrength>> {
  let values = new Map<string, SpyStrength>();
  if (!tickers.length) return values;
  try {
    if (store) values = await store.get(date, tickers);
  } catch {
    // Degrade to fetching; the result stays correct.
  }
  const missing = tickers.filter((t) => !values.has(t));
  if (!missing.length) return values;
  try {
    const sessions = previousSessions(date, betaReturns + 1);
    const daily = await multi(
      [...new Set([...missing, benchmark])],
      `${sessions[0]}T00:00:00Z`,
      // Ends at the board date's midnight UTC, before its daily bar.
      `${date}T00:00:00Z`,
      "1Day",
      "split",
    );
    const spy = daily.get(benchmark) ?? [];
    // Without SPY history every value would be "assumed": not worth storing.
    if (!spy.length) return values;
    const fresh = new Map(
      missing.map((t) => [t, spyStrength(sessions, daily.get(t) ?? [], spy)]),
    );
    for (const [t, value] of fresh) values.set(t, value);
    try {
      await store?.put(date, fresh);
    } catch {
      // Not stored this time; recomputed on the next poll.
    }
  } catch {
    // History or calendar unavailable: score and β are reported as null.
  }
  return values;
}

/** Close of the newest complete bar of `date` ending by `asOf`. */
function closeAt(rows: RawBar[], ticker: string, date: string, asOf: number) {
  let close: number | null = null;
  for (const row of rows)
    if (
      row.start + baselineStep * 60 <= asOf &&
      normalize(ticker, row, "shares")?.date === date
    )
      close = row.close;
  return close;
}

function stats(
  ticker: string,
  rows: RawBar[],
  date: string,
  asOf: number,
  curve: VolumeCurve | undefined,
): BoardStats {
  let dayLow: number | null = null;
  let dayHigh: number | null = null;
  let volume = 0;
  for (const row of rows) {
    const bar = normalize(ticker, row, "shares");
    if (bar?.date !== date) continue;
    dayLow = dayLow === null ? row.low : Math.min(dayLow, row.low);
    dayHigh = dayHigh === null ? row.high : Math.max(dayHigh, row.high);
    if (bar.session === "regular" && row.start + baselineStep * 60 <= asOf)
      volume += row.volume;
  }
  const minute = newYork(asOf * 1000).minute;
  const typicalVolume =
    curve && minute > 570
      ? typicalAt(curve, Math.min(minute, coreClose(date)!))
      : null;
  return {
    asOf,
    dayLow,
    dayHigh,
    volume,
    typicalVolume,
    relVolume: typicalVolume ? volume / typicalVolume : null,
    rsScore: null,
    beta: null,
  };
}

export async function runBoard(
  tickers: string[],
  multi: MultiHistory,
  now = Date.now(),
  benchmarks: Record<string, string> = {},
  store?: BaselineStore,
  strengthStore?: StrengthStore,
): Promise<Board> {
  const date = latestSession(now);
  const previous = previousSessions(date, 1)[0]!;
  const sectors = tickers.flatMap((t) =>
    benchmarks[t] ? [benchmarks[t]] : [],
  );
  const symbols = [
    ...new Set([...tickers, benchmark, nasdaq, ...sectors]),
  ].slice(0, maxBoardSymbols);
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const end = Math.min(
    Date.parse(`${next.toISOString().slice(0, 10)}T06:00:00Z`),
    now - sipDelay,
  );
  const listed = tickers.filter((t) => symbols.includes(t));
  // Volume stats use only complete 5-minute bars: as of the latest 5-minute
  // boundary with data, capped at 20:00 New York (the end of after-hours).
  const step = baselineStep * 60;
  const asOf =
    Math.floor(Math.min(end, newYorkToUtc(date, 1200)) / 1000 / step) * step;
  const [intraday, daily, curves, strength] = await Promise.all([
    multi(symbols, `${date}T00:00:00Z`, new Date(end).toISOString(), "5Min"),
    multi(symbols, `${previous}T00:00:00Z`, `${date}T00:00:00Z`, "1Day"),
    baselines(listed, date, multi, store),
    strengths(listed, date, multi, strengthStore),
  ]);
  const previousCloses = new Map(
    symbols.map((ticker) => [
      ticker,
      (daily.get(ticker) ?? []).find(
        (row) => newYork(row.start * 1000).date === previous,
      )?.close ?? null,
    ]),
  );
  // Score vs SPY at asOf: % from the previous daily close to the newest
  // complete 5-minute bar, for the stock and for SPY.
  const change = (ticker: string) => {
    const base = previousCloses.get(ticker);
    const close = closeAt(intraday.get(ticker) ?? [], ticker, date, asOf);
    return base && close !== null ? (close / base - 1) * 100 : null;
  };
  const spyChange = change(benchmark);
  return {
    source: "alpaca",
    feed: "sip",
    date,
    open: newYorkToUtc(date, 570) / 1000,
    close: newYorkToUtc(date, coreClose(date)!) / 1000,
    watchlist: listed,
    benchmarks: Object.fromEntries(
      Object.entries(benchmarks).filter(
        ([t, etf]) => tickers.includes(t) && symbols.includes(etf),
      ),
    ),
    series: symbols.map((ticker) => {
      const points: [number, number][] = [];
      for (const row of intraday.get(ticker) ?? []) {
        const bar = normalize(ticker, row, "shares");
        if (bar?.date === date) points.push([row.start, row.close]);
      }
      const series: BoardSeries = {
        ticker,
        previousClose: previousCloses.get(ticker) ?? null,
        points,
      };
      if (listed.includes(ticker)) {
        series.stats = stats(
          ticker,
          intraday.get(ticker) ?? [],
          date,
          asOf,
          curves.get(ticker),
        );
        const value = strength.get(ticker);
        const stock = change(ticker);
        if (value) {
          series.stats.beta = value.betaAssumed ? null : value.beta;
          series.stats.rsScore =
            stock !== null && spyChange !== null
              ? rsScore(
                  excessPercent(stock, spyChange, value.beta),
                  value.sigma,
                )
              : null;
        }
      }
      return series;
    }),
  };
}

export async function handleBoard(
  tickers: string[],
  benchmarks: Record<string, string>,
  credentials: Credentials,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  store?: BaselineStore,
  strengthStore?: StrengthStore,
): Promise<{ status: number; body: Board | { error: string } }> {
  if (!credentials.key || !credentials.secret)
    return {
      status: 503,
      body: { error: "Alpaca credentials are not configured on the server" },
    };
  const feed = new AlpacaFeed(
    credentials.key,
    credentials.secret,
    "sip",
    () => {},
    fetcher,
  );
  try {
    return {
      status: 200,
      body: await runBoard(
        tickers,
        (symbols, start, end, timeframe, adjustment) =>
          feed.multiHistory(symbols, start, end, timeframe, adjustment),
        now,
        benchmarks,
        store,
        strengthStore,
      ),
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
