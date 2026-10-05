import { AlpacaFeed } from "./alpaca.js";
import type { Credentials } from "./backtest.js";
import {
  dayMarks,
  fromRawBars,
  marksAt,
  regularOpen,
  type MarkBar,
} from "./marks-vs-spy.js";
import {
  marksSigmas,
  sigmaRowsPerInsert,
  type MarksSigmaStore,
  type MinuteHistory,
} from "./marks-sigma.js";
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
  // Marked-sections score vs SPY (0–100) with E = the minute bar that
  // closes at asOf, or the last regular minute after the close
  // (docs/features/marks-vs-spy.md); null before 09:30, without σ (or σ = 0 early in the session), without SPY's or the
  // stock's bars by E, or while the symbol's σ curve is not computed yet.
  // Always against SPY.
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

/** Score inputs for the board: minute history and stored σ curves. */
export interface BoardArea {
  // One symbol's minute bars, straight from Alpaca: at most 2 pages for 20
  // sessions (≤ 960 bars a day, 10,000 per page), no D1 statements.
  history: MinuteHistory;
  store?: MarksSigmaStore;
  // Most σ curves computed per poll (default: sigmaSymbolsPerPoll).
  perPoll?: number;
}

/**
 * Subrequests one board request may use (Workers Free allows 50; Alpaca
 * pages, D1 statements and the collector's watchlist all count).
 */
export const boardSubrequestBudget = 40;
const pages = (bars: number) => Math.max(1, Math.ceil(bars / 10000));

/**
 * σ curves one warm board poll can compute within the budget, worst case:
 * fixed = watchlist 1 + 5-minute intraday pages (192 bars a symbol) + daily
 * 1 + 3 stored-value reads + 3 table checks (first request of an isolate) +
 * 1-minute pages (≤ 390 regular bars a symbol, listed and SPY); then SPY's
 * σ history 2, the σ write 1 + ⌈k/16⌉, and 2 Alpaca pages per symbol. Polls
 * that fetch Rel vol or β history compute none.
 */
export function sigmaSymbolsPerPoll(symbols: number, listed: number): number {
  const fixed =
    1 + pages(symbols * 192) + 1 + 3 + 3 + pages((listed + 1) * 390);
  let k = listed;
  while (
    k > 0 &&
    fixed + 2 + 1 + Math.ceil(k / sigmaRowsPerInsert) + 2 * k >
      boardSubrequestBudget
  )
    k--;
  return k;
}

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
  cold?: { value: boolean },
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
  if (cold) cold.value = true;
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
  cold?: { value: boolean },
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
  if (cold) cold.value = true;
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
 * Regular-session minute bars of `date` for the listed symbols and SPY, from
 * 09:30 New York to `asOf` (Unix s). Failures leave the score null.
 */
async function regularMinutes(
  listed: string[],
  date: string,
  asOf: number,
  multi: MultiHistory,
): Promise<Map<string, RawBar[]> | null> {
  try {
    return await multi(
      [...new Set([...listed, benchmark])],
      new Date(newYorkToUtc(date, regularOpen)).toISOString(),
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
  // Score at asOf: E is the minute bar closing at asOf, clamped to the
  // regular session's last minute after the close (after-hours shows the
  // day's closing score); null before 09:30 (Product + UX, 2026-10-05).
  const closeMinute = coreClose(date)!;
  const asOfAt = newYork(asOf * 1000 - 60000);
  const scoredAt = {
    date: asOfAt.date,
    minute: Math.min(asOfAt.minute, closeMinute - 1),
  };
  const scoredEnd = Math.min(asOf, newYorkToUtc(date, closeMinute) / 1000);
  const scored =
    area !== undefined &&
    listed.some((t) => t !== benchmark) &&
    scoredAt.date === date &&
    scoredAt.minute >= regularOpen;
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
  // A poll that fetches Rel vol or β history computes no σ curve: together
  // they would exceed the Worker's subrequest budget.
  const cold = { value: false };
  const curveRequest = baselines(listed, date, multi, store, cold);
  const strengthRequest = strengths(listed, date, multi, strengthStore, cold);
  const [intraday, daily, curves, strength, minutes, sigmas] =
    await Promise.all([
      intradayRequest,
      dailyRequest,
      curveRequest,
      strengthRequest,
      scored ? regularMinutes(listed, date, scoredEnd, multi) : null,
      scored
        ? Promise.all([strengthRequest, curveRequest]).then(([values]) =>
            // Only with the date's β: a stored curve is kept all day.
            marksSigmas(
              listed.filter((t) => values.has(t)),
              date,
              (t) => values.get(t)!.beta,
              area.history,
              area.store,
              cold.value
                ? 0
                : (area.perPoll ??
                    sigmaSymbolsPerPoll(symbols.length, listed.length)),
              // Rotating start: a symbol that keeps failing never blocks the rest.
              Math.floor(now / 60000),
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
  // Previous closes from the daily bars (the official close; the chart uses
  // the last regular minute's close).
  const dayOf = (ticker: string) => ({
    ticker,
    previousClose: previousCloses.get(ticker) ?? null,
    bars: fromRawBars(ticker, minutes?.get(ticker) ?? []).filter(
      (b: MarkBar) => b.date === date,
    ),
  });
  const spyDay = dayOf(benchmark);
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
          series.stats.rsScore = marksAt(
            ticker,
            dayMarks(dayOf(ticker), spyDay, date),
            scoredAt.minute,
            value?.beta ?? 1,
            sigmas.get(ticker),
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
  sigmas?: MarksSigmaStore,
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
          // Direct, not through the bar cache: a bounded cost per symbol.
          history: (ticker, start, end) => feed.history(ticker, start, end),
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
