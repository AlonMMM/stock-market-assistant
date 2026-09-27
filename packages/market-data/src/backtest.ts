import {
  defaults,
  validateConfig,
  type Config,
  type Evaluation,
} from "../../alerts/src/relative-volume.js";
import { AlpacaFeed } from "./alpaca.js";
import { cachedHistory, type BarCache, type CacheStats } from "./bar-cache.js";
import { benchmark, betaReturns, dailyBeta } from "./beta.js";
import { normalize, type PriceBar, type RawBar } from "./bars.js";
import {
  OutcomeScorer,
  parseValidation,
  summarize,
  ValidationInputError,
  type Outcome,
  type ValidationConfig,
  type ValidationSummary,
} from "./outcome.js";
import { coreClose, previousSessions } from "./calendar.js";
import { LiveEvaluator } from "./evaluator.js";

export const backtestLimits = { tickers: 10, sessions: 20 };
export const tickerPattern = /^[A-Z][A-Z0-9. -]{0,9}$/;
// Alpaca's free plan serves SIP history except the most recent 15 minutes.
export const sipDelay = 15 * 60000;

export type History = (
  ticker: string,
  start: string,
  end: string,
) => Promise<RawBar[]>;

// Where the ticker stood against the market at the alert minute. Percent
// changes are from each symbol's previous regular close; `excess` is the gap
// between the ticker line and the SPY × beta line on the day chart.
export interface AlertContext {
  change: number;
  spyChange: number;
  beta: number;
  excess: number; // change − beta × spyChange, percentage points
}

export interface BacktestAlert extends Evaluation {
  close: number;
  context: AlertContext | null; // null for SPY or without enough data
  outcome: Outcome; // what the price did after the alert
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
  // Outcome summary for these alerts, and for plain momentum entries at every
  // fifth regular minute (the baseline) in the same symbols and days.
  validation: ValidationSummary;
  cache?: CacheStats; // symbol-days served from the bar cache vs fetched
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
    !tickers.every((t) => typeof t === "string" && tickerPattern.test(t)) ||
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
  let validation: ValidationConfig;
  try {
    validation = parseValidation((body as { validation?: unknown }).validation);
  } catch (error) {
    if (error instanceof ValidationInputError)
      throw new BacktestInputError(error.message);
    throw error;
  }
  return {
    tickers: tickers as string[],
    from,
    to,
    config,
    sessions,
    warmup,
    validation,
  };
}

interface MarketTrack {
  lastRegular: Map<string, number>;
  byDate: Map<string, { end: number; close: number }[]>;
}

function marketTrack(ticker: string, rows: RawBar[]): MarketTrack {
  const track: MarketTrack = { lastRegular: new Map(), byDate: new Map() };
  for (const row of rows) {
    const bar = normalize(ticker, row, "shares");
    if (!bar) continue;
    if (bar.session === "regular") track.lastRegular.set(bar.date, bar.close);
    const day = track.byDate.get(bar.date) ?? [];
    day.push({ end: Date.parse(bar.end), close: bar.close });
    track.byDate.set(bar.date, day);
  }
  return track;
}

function context(
  date: string,
  end: number,
  close: number,
  lastRegular: Map<string, number>,
  spy: MarketTrack,
  tickerDaily: RawBar[],
  spyDaily: RawBar[],
): AlertContext | null {
  const previous = previousSessions(date, 1)[0]!;
  const base = lastRegular.get(previous);
  const spyBase = spy.lastRegular.get(previous);
  // Latest SPY minute that closed at or before the alert minute, same day.
  const spyBar = spy.byDate
    .get(date)
    ?.findLast((b) => b.end <= end && b.end > end - 5 * 60000);
  const beta = dailyBeta(
    previousSessions(date, betaReturns + 1),
    tickerDaily,
    spyDaily,
  ).value;
  if (!base || !spyBase || !spyBar || beta === null) return null;
  const change = (close / base - 1) * 100;
  const spyChange = (spyBar.close / spyBase - 1) * 100;
  return { change, spyChange, beta, excess: change - beta * spyChange };
}

// Replays Alpaca minute bars through the live evaluator, as if each bar had
// been received the moment it closed. Warmup bars build the baseline only.
export async function runBacktest(
  input: unknown,
  history: History,
  now = Date.now(),
  daily: History = async () => [],
): Promise<BacktestResult> {
  const { tickers, from, to, config, sessions, warmup, validation } = parse(
    input,
    now,
  );
  const outcomes: Outcome[] = [];
  const baseline: Outcome[] = [];
  const next = new Date(`${to}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  // 06:00Z is after the latest post-market close (01:00Z in winter) and
  // before the next pre-market; later bars are filtered by date anyway.
  const end = Math.min(
    Date.parse(`${next.toISOString().slice(0, 10)}T06:00:00Z`),
    now - sipDelay,
  );
  const until = new Date(end).toISOString();
  const others = tickers.filter((t) => t !== benchmark);
  let betaStart: string | null = null;
  try {
    betaStart = previousSessions(from, betaReturns + 1)[0]!;
  } catch {
    // Outside calendar coverage: alerts carry no market context.
  }
  const [rows, spyRows, dailyRows] = await Promise.all([
    Promise.all(
      tickers.map((ticker) => history(ticker, `${warmup[0]}T00:00:00Z`, until)),
    ),
    others.length && betaStart
      ? history(benchmark, `${warmup[warmup.length - 1]}T00:00:00Z`, until)
      : [],
    others.length && betaStart
      ? Promise.all(
          [...others, benchmark].map((t) =>
            daily(t, `${betaStart}T00:00:00Z`, `${to}T00:00:00Z`),
          ),
        )
      : [],
  ]);
  const dailyBy = new Map(
    [...others, benchmark].map((t, i) => [t, dailyRows[i] ?? []]),
  );
  const spy = marketTrack(benchmark, spyRows);
  const alerts: BacktestAlert[] = [];
  const diagnostics: Record<string, number> = {};
  const coverage: BacktestResult["coverage"] = [];
  let evaluated = 0;
  tickers.forEach((ticker, index) => {
    const evaluator = new LiveEvaluator(config);
    const seen = new Set<string>();
    const lastRegular = new Map<string, number>();
    const normalized: PriceBar[] = [];
    const tickerAlerts: BacktestAlert[] = [];
    let count = 0;
    for (const row of rows[index]!) {
      const bar = normalize(ticker, row, "shares");
      if (!bar || bar.date > to || Date.parse(bar.end) > end) continue;
      normalized.push(bar);
      if (bar.session === "regular") lastRegular.set(bar.date, bar.close);
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
        tickerAlerts.push({
          ...result,
          close: bar.close,
          outcome: undefined as unknown as Outcome, // scored below
          context:
            ticker === benchmark || !betaStart
              ? null
              : context(
                  bar.date,
                  Date.parse(bar.end),
                  bar.close,
                  lastRegular,
                  spy,
                  dailyBy.get(ticker)!,
                  dailyBy.get(benchmark)!,
                ),
        });
    }
    // Outcomes need the bars after each alert, so score once all are read.
    const scorer = new OutcomeScorer(normalized, validation);
    for (const alert of tickerAlerts) {
      alert.outcome = scorer.score(alert.end, alert.direction ?? "up");
      outcomes.push(alert.outcome);
      alerts.push(alert);
    }
    baseline.push(...scorer.baseline(from, to));
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
    validation: summarize(outcomes, baseline, validation),
  };
}

export interface Credentials {
  key?: string;
  secret?: string;
}

// Shared by the local API and the hosted Worker so both behave identically.
/** Minute-bar history through the cache when one is configured. */
export function minuteHistory(
  feed: AlpacaFeed,
  cache: BarCache | undefined,
  now: number,
  stats?: CacheStats,
): History {
  return (ticker, start, end) =>
    cache
      ? cachedHistory(
          `${ticker}:sip:1Min:raw`,
          start,
          end,
          (s, e) => feed.history(ticker, s, e),
          cache,
          now - sipDelay,
          stats,
        )
      : feed.history(ticker, start, end);
}

export async function handleBacktest(
  body: unknown,
  credentials: Credentials,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  cache?: BarCache,
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
    const stats: CacheStats = { hits: 0, misses: 0 };
    const result = await runBacktest(
      body,
      minuteHistory(feed, cache, now, stats),
      now,
      (ticker, start, end) => feed.history(ticker, start, end, "1Day", "split"),
    );
    return { status: 200, body: cache ? { ...result, cache: stats } : result };
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
