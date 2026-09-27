import { AlpacaFeed } from "./alpaca.js";
import {
  sipDelay,
  tickerPattern,
  type Credentials,
  type History,
} from "./backtest.js";
import { benchmark, betaReturns, dailyBeta } from "./beta.js";
import { normalize } from "./bars.js";
import { coreClose, previousSessions } from "./calendar.js";

export { benchmark, dailyBeta } from "./beta.js";

export interface ChartBar {
  start: number; // bar start, Unix seconds (UTC)
  session: "pre" | "regular" | "post";
  open: number;
  close: number;
  volume: number;
}

export interface ChartSeries {
  ticker: string;
  // Last regular-session close of the previous trading day, the base for
  // intraday % change; null when that session has no bars.
  previousClose: number | null;
  bars: ChartBar[];
}

export interface DayChart {
  source: "alpaca";
  feed: "sip";
  date: string;
  series: ChartSeries[]; // requested ticker first, then the benchmark
  // Ticker beta vs SPY; null for SPY itself or with too few paired returns.
  beta: { value: number | null; returns: number; lookback: number };
}

export class DayChartInputError extends Error {}

function parse(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new DayChartInputError("Expected JSON object");
  const { ticker, date } = input as { ticker?: unknown; date?: unknown };
  if (typeof ticker !== "string" || !tickerPattern.test(ticker))
    throw new DayChartInputError("Choose one US stock symbol");
  let open: boolean;
  try {
    open =
      typeof date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      coreClose(date) !== null;
  } catch {
    open = false;
  }
  if (!open) throw new DayChartInputError("Choose a 2026–2028 US trading day");
  return { ticker, date: date as string };
}

// One trading day of minute bars (pre-market through after-hours) for a ticker
// and SPY, each symbol's previous regular close, and the ticker's beta.
export async function runDayChart(
  input: unknown,
  history: History,
  now = Date.now(),
  daily: History = async () => [],
): Promise<DayChart> {
  const { ticker, date } = parse(input);
  let previous: string;
  try {
    previous = previousSessions(date, 1)[0]!;
  } catch {
    throw new DayChartInputError("Choose a 2026–2028 US trading day");
  }
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const end = Math.min(
    Date.parse(`${next.toISOString().slice(0, 10)}T06:00:00Z`),
    now - sipDelay,
  );
  const start = `${previous}T00:00:00Z`;
  if (Date.parse(start) >= end)
    throw new DayChartInputError("That day has no data yet");
  const tickers = ticker === benchmark ? [ticker] : [ticker, benchmark];
  let betaSessions: string[] = [];
  try {
    betaSessions = previousSessions(date, betaReturns + 1);
  } catch {
    // Outside calendar coverage: beta is reported as unavailable.
  }
  const [rows, dailyRows] = await Promise.all([
    Promise.all(
      tickers.map((t) => history(t, start, new Date(end).toISOString())),
    ),
    tickers.length === 2 && betaSessions.length > 0
      ? Promise.all(
          // Ends at the chart day's midnight UTC, before its daily bar: no look-ahead.
          tickers.map((t) =>
            daily(t, `${betaSessions[0]}T00:00:00Z`, `${date}T00:00:00Z`),
          ),
        )
      : null,
  ]);
  const beta = dailyRows
    ? dailyBeta(betaSessions, dailyRows[0]!, dailyRows[1]!)
    : { value: null, returns: 0 };
  return {
    source: "alpaca",
    feed: "sip",
    date,
    beta: { ...beta, lookback: betaReturns },
    series: tickers.map((t, index) => {
      const bars: ChartBar[] = [];
      let previousClose: number | null = null;
      for (const row of rows[index]!) {
        const bar = normalize(t, row, "shares");
        if (!bar) continue;
        if (bar.date === previous && bar.session === "regular")
          previousClose = bar.close;
        else if (bar.date === date)
          bars.push({
            start: row.start,
            session: bar.session,
            open: bar.open,
            close: bar.close,
            volume: bar.volume,
          });
      }
      return { ticker: t, previousClose, bars };
    }),
  };
}

// Shared by the local API and the hosted Worker so both behave identically.
export async function handleDayChart(
  body: unknown,
  credentials: Credentials,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ status: number; body: DayChart | { error: string } }> {
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
      body: await runDayChart(
        body,
        (ticker, start, end) => feed.history(ticker, start, end),
        now,
        (ticker, start, end) =>
          feed.history(ticker, start, end, "1Day", "split"),
      ),
    };
  } catch (error) {
    if (error instanceof DayChartInputError)
      return { status: 400, body: { error: error.message } };
    // Adapter errors carry only status codes, never credentials or bodies.
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
