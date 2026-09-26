import {
  defaults,
  validateConfig,
  type Config,
  type Evaluation,
} from "../../alerts/src/relative-volume.js";
import { AlpacaFeed } from "./alpaca.js";
import { normalize, type RawBar } from "./bars.js";
import { coreClose, previousSessions } from "./calendar.js";
import { LiveEvaluator } from "./evaluator.js";

export const backtestLimits = { tickers: 10, sessions: 20 };
// Alpaca's free plan serves SIP history except the most recent 15 minutes.
const sipDelay = 15 * 60000;

export type History = (
  ticker: string,
  start: string,
  end: string,
) => Promise<RawBar[]>;

export interface BacktestAlert extends Evaluation {
  close: number;
}

export interface BacktestResult {
  source: "alpaca";
  feed: "sip";
  tickers: string[];
  from: string;
  to: string;
  config: Config;
  evaluated: number;
  alerts: BacktestAlert[];
  diagnostics: Record<string, number>;
  coverage: { ticker: string; bars: number; missingSessions: string[] }[];
}

export class BacktestInputError extends Error {}

function sessionsBetween(from: string, to: string): string[] {
  const result: string[] = [];
  const cursor = new Date(`${from}T12:00:00Z`);
  for (let d = from; d <= to;) {
    if (coreClose(d) !== null) result.push(d);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    d = cursor.toISOString().slice(0, 10);
  }
  return result;
}

function parse(input: unknown, now: number) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new BacktestInputError("Expected JSON object");
  const body = input as {
    tickers?: unknown;
    from?: unknown;
    to?: unknown;
    config?: unknown;
  };
  const tickers = body.tickers;
  if (
    !Array.isArray(tickers) ||
    tickers.length < 1 ||
    tickers.length > backtestLimits.tickers ||
    !tickers.every(
      (t) => typeof t === "string" && /^[A-Z][A-Z0-9. -]{0,9}$/.test(t),
    ) ||
    new Set(tickers).size !== tickers.length
  )
    throw new BacktestInputError(
      `Choose 1–${backtestLimits.tickers} distinct US stock symbols`,
    );
  const { from, to } = body;
  if (
    typeof from !== "string" ||
    typeof to !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    from > to
  )
    throw new BacktestInputError("Choose a valid date range (from ≤ to)");
  if (Date.parse(`${from}T00:00:00Z`) > now)
    throw new BacktestInputError("The range must start in the past");
  if (
    body.config !== undefined &&
    (!body.config ||
      typeof body.config !== "object" ||
      Array.isArray(body.config))
  )
    throw new BacktestInputError("Invalid configuration");
  const config: Config = { ...defaults, ...(body.config as Partial<Config>) };
  try {
    validateConfig(config);
  } catch (error) {
    throw new BacktestInputError((error as Error).message);
  }
  let sessions: string[];
  let warmup: string[];
  try {
    sessions = sessionsBetween(from, to);
    warmup = previousSessions(from, config.days);
  } catch {
    throw new BacktestInputError(
      `Dates, including ${config.days} warmup sessions before the start, must fall within 2026–2028`,
    );
  }
  if (sessions.length < 1)
    throw new BacktestInputError("The range contains no trading sessions");
  if (sessions.length > backtestLimits.sessions)
    throw new BacktestInputError(
      `Choose at most ${backtestLimits.sessions} trading sessions`,
    );
  return { tickers: tickers as string[], from, to, config, sessions, warmup };
}

// Replays Alpaca minute bars through the live evaluator, as if each bar had
// been received the moment it closed. Warmup bars build the baseline only.
export async function runBacktest(
  input: unknown,
  history: History,
  now = Date.now(),
): Promise<BacktestResult> {
  const { tickers, from, to, config, sessions, warmup } = parse(input, now);
  const next = new Date(`${to}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  // 06:00Z is after the latest post-market close (01:00Z in winter) and
  // before the next pre-market; later bars are filtered by date anyway.
  const end = Math.min(
    Date.parse(`${next.toISOString().slice(0, 10)}T06:00:00Z`),
    now - sipDelay,
  );
  const rows = await Promise.all(
    tickers.map((ticker) =>
      history(ticker, `${warmup[0]}T00:00:00Z`, new Date(end).toISOString()),
    ),
  );
  const alerts: BacktestAlert[] = [];
  const diagnostics: Record<string, number> = {};
  const coverage: BacktestResult["coverage"] = [];
  let evaluated = 0;
  tickers.forEach((ticker, index) => {
    const evaluator = new LiveEvaluator(config);
    const seen = new Set<string>();
    let count = 0;
    for (const row of rows[index]!) {
      const bar = normalize(ticker, row, "shares");
      if (!bar || bar.date > to || Date.parse(bar.end) > end) continue;
      const inRange = bar.date >= from;
      if (inRange) {
        seen.add(bar.date);
        count++;
      }
      const result = evaluator.push(bar, Date.parse(bar.end), inRange);
      if (!result) continue;
      evaluated++;
      diagnostics[result.status] = (diagnostics[result.status] ?? 0) + 1;
      if (result.status === "alert")
        alerts.push({ ...result, close: bar.close });
    }
    coverage.push({
      ticker,
      bars: count,
      missingSessions: sessions.filter(
        (date) => !seen.has(date) && Date.parse(`${date}T13:30:00Z`) < end,
      ),
    });
  });
  alerts.sort(
    (a, b) => a.end.localeCompare(b.end) || a.ticker.localeCompare(b.ticker),
  );
  return {
    source: "alpaca",
    feed: "sip",
    tickers,
    from,
    to,
    config,
    evaluated,
    alerts,
    diagnostics,
    coverage,
  };
}

export interface Credentials {
  key?: string;
  secret?: string;
}

// Shared by the local API and the hosted Worker so both behave identically.
export async function handleBacktest(
  body: unknown,
  credentials: Credentials,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ status: number; body: BacktestResult | { error: string } }> {
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
      body: await runBacktest(
        body,
        (ticker, start, end) => feed.history(ticker, start, end),
        now,
      ),
    };
  } catch (error) {
    if (error instanceof BacktestInputError)
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
