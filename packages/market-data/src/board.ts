import { AlpacaFeed } from "./alpaca.js";
import { sipDelay, type Credentials } from "./backtest.js";
import { normalize, type RawBar } from "./bars.js";
import { benchmark } from "./beta.js";
import {
  coreClose,
  newYork,
  newYorkToUtc,
  previousSessions,
} from "./calendar.js";

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

type MultiHistory = (
  tickers: string[],
  start: string,
  end: string,
  timeframe: "5Min" | "1Day",
) => Promise<Map<string, RawBar[]>>;

/** Latest US session with (15-minute delayed) data at `now`. */
export function latestSession(now: number): string {
  const { date, minute } = newYork(now - sipDelay);
  // Pre-market data starts 04:00 New York time.
  if (coreClose(date) !== null && minute >= 240) return date;
  return previousSessions(date, 1)[0]!;
}

export async function runBoard(
  tickers: string[],
  multi: MultiHistory,
  now = Date.now(),
  benchmarks: Record<string, string> = {},
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
  const [intraday, daily] = await Promise.all([
    multi(symbols, `${date}T00:00:00Z`, new Date(end).toISOString(), "5Min"),
    multi(symbols, `${previous}T00:00:00Z`, `${date}T00:00:00Z`, "1Day"),
  ]);
  return {
    source: "alpaca",
    feed: "sip",
    date,
    open: newYorkToUtc(date, 570) / 1000,
    close: newYorkToUtc(date, coreClose(date)!) / 1000,
    watchlist: tickers.filter((t) => symbols.includes(t)),
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
      const close = (daily.get(ticker) ?? []).find(
        (row) => newYork(row.start * 1000).date === previous,
      )?.close;
      return { ticker, previousClose: close ?? null, points };
    }),
  };
}

export async function handleBoard(
  tickers: string[],
  benchmarks: Record<string, string>,
  credentials: Credentials,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
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
        (symbols, start, end, timeframe) =>
          feed.multiHistory(symbols, start, end, timeframe),
        now,
        benchmarks,
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
