import { AlpacaFeed } from "./alpaca.js";
import { minuteHistory, type Credentials } from "./backtest.js";
import { areaAt, fromRawBars, sessionOf } from "./area-vs-spy.js";
import {
  areaSigmas,
  type AreaSigmaStore,
  type MinuteHistory,
} from "./area-sigma.js";
import type { BarCache } from "./bar-cache.js";
import { defaultSipDelayMinutes, sipDelayMs } from "./sip-delay.js";
import { normalize, type RawBar } from "./bars.js";
import type { D1Like } from "./bar-cache.js";
import { benchmark, betaReturns } from "./beta.js";
import {
  coreClose,
  newYork,
  newYorkToUtc,
  previousSessions,
} from "./calendar.js";
import { spyStrength, type SpyStrength } from "./rs-score.js";
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
  // Area score vs SPY (0–100) ending at the minute bar that closes at asOf
  // (docs/features/area-vs-spy.md); null without σ, SPY's bars or the
  // stock's bars in that session, in a window's first 5 minutes, or while
  // the symbol's σ curve is not computed yet. Always against SPY.
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
  // Minutes the data may lag real time (ALPACA_SIP_DELAY_MINUTES); 0 = live.
  delayMinutes?: number;
}

export type MultiHistory = (
  tickers: string[],
  start: string,
  end: string,
  timeframe: "1Min" | "5Min" | "1Day",
  adjustment?: "raw" | "split",
) => Promise<Map<string, RawBar[]>>;

/** Area score inputs for the board: minute history and stored σ curves. */
export interface BoardArea {
  history: MinuteHistory; // one symbol's minute bars (bar cache when set)
  store?: AreaSigmaStore;
  // Most σ curves computed per poll; the rest follow on later polls.
  perPoll?: number;
}
export const sigmasPerPoll = 20;

/** β/σ vs SPY per symbol and board date, computed once per day. */
export type StrengthStore = DailyStore<SpyStrength>;

/** D1 store (the bar-cache database) for β/σ vs SPY. */
export class D1StrengthStore extends D1DailyStore<SpyStrength> {
  constructor(db: D1Like) {
    super(db, "spy_strength", "strength");
  }
}

/** Latest US session with data at `now`, allowing for the SIP delay. */
export function latestSession(now: number, delayMinutes?: number): string {
  const { date, minute } = newYork(now - sipDelayMs(delayMinutes));
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

/**
 * Minute bars of `date` for the listed symbols and SPY, from the start of the
 * session that contains New York minute `minute` (pre-market from 04:00) to
 * `asOf` (Unix s). Failures leave the score null.
 */
async function areaMinutes(
  listed: string[],
  date: string,
  minute: number,
  asOf: number,
  multi: MultiHistory,
): Promise<Map<string, RawBar[]> | null> {
  const session = sessionOf(date, minute);
  const from =
    session === "pre" ? 240 : session === "regular" ? 570 : coreClose(date)!;
  try {
    return await multi(
      [...new Set([...listed, benchmark])],
      new Date(newYorkToUtc(date, from)).toISOString(),
      new Date(asOf * 1000).toISOString(),
      "1Min",
    );
  } catch {
    return null;
  }
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
  delayMinutes = defaultSipDelayMinutes,
  area?: BoardArea,
): Promise<Board> {
  const date = latestSession(now, delayMinutes);
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
    now - sipDelayMs(delayMinutes),
  );
  const listed = tickers.filter((t) => symbols.includes(t));
  // Volume stats use only complete 5-minute bars: as of the latest 5-minute
  // boundary with data, capped at 20:00 New York (the end of after-hours).
  const step = baselineStep * 60;
  const asOf =
    Math.floor(Math.min(end, newYorkToUtc(date, 1200)) / 1000 / step) * step;
  // Area score at asOf: the minute bar closing at asOf ends the window.
  const scoredAt = newYork(asOf * 1000 - 60000);
  const scored =
    area !== undefined &&
    listed.some((t) => t !== benchmark) &&
    scoredAt.date === date &&
    scoredAt.minute >= 240 &&
    scoredAt.minute < 1200;
  // Requests start in this order: intraday, daily, baselines, β/σ.
  const intradayRequest = multi(
    symbols,
    `${date}T00:00:00Z`,
    new Date(end).toISOString(),
    "5Min",
  );
  const dailyRequest = multi(
    symbols,
    `${previous}T00:00:00Z`,
    `${date}T00:00:00Z`,
    "1Day",
  );
  const curveRequest = baselines(listed, date, multi, store);
  const strengthRequest = strengths(listed, date, multi, strengthStore);
  const [intraday, daily, curves, strength, minutes, sigmas] =
    await Promise.all([
      intradayRequest,
      dailyRequest,
      curveRequest,
      strengthRequest,
      scored ? areaMinutes(listed, date, scoredAt.minute, asOf, multi) : null,
      scored
        ? strengthRequest.then((values) =>
            // Only with the date's β: a stored curve is kept all day.
            areaSigmas(
              listed.filter((t) => values.has(t)),
              date,
              (t) => values.get(t)!.beta,
              area.history,
              area.store,
              area.perPoll ?? sigmasPerPoll,
            ),
          )
        : null,
    ]);
  const previousCloses = new Map(
    symbols.map((ticker) => [
      ticker,
      (daily.get(ticker) ?? []).find(
        (row) => newYork(row.start * 1000).date === previous,
      )?.close ?? null,
    ]),
  );
  const spyMinutes = fromRawBars(benchmark, minutes?.get(benchmark) ?? []);
  return {
    source: "alpaca",
    feed: "sip",
    delayMinutes,
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
        if (value) series.stats.beta = value.betaAssumed ? null : value.beta;
        if (minutes && sigmas)
          series.stats.rsScore = areaAt(
            {
              ticker,
              stock: fromRawBars(ticker, minutes.get(ticker) ?? []),
              spy: spyMinutes,
              date,
              beta: value?.beta ?? 1,
              sigma: sigmas.get(ticker) ?? null,
            },
            scoredAt.minute,
          ).score;
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
  cache?: BarCache,
  sigmas?: AreaSigmaStore,
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
        credentials.sipDelayMinutes,
        {
          history: minuteHistory(
            feed,
            cache,
            now,
            undefined,
            credentials.sipDelayMinutes,
          ),
          store: sigmas,
        },
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
