import {
  lookNow,
  LookNowScorer,
  RandomMinutes,
  summarizeLookNow,
  type LookNow,
  type LookNowSummary,
} from "./look-now.js";
import {
  defaults,
  validateConfig,
  type Config,
  type Evaluation,
} from "../../alerts/src/relative-volume.js";
import type { AlertVsSpy } from "../../contracts/src/vs-spy.js";
import { AlpacaFeed } from "./alpaca.js";
import { sipDelayMs } from "./sip-delay.js";
import { alertVsSpy } from "./alert-vs-spy.js";
import {
  fromPriceBar,
  historyMarks,
  marksSigmaSessions,
  sigmaCurve,
  type DayMarks,
  type MarkBar,
  type MarksSigma,
} from "./marks-vs-spy.js";
import { spyStrength, type SpyStrength } from "./rs-score.js";
import { cachedHistory, type BarCache, type CacheStats } from "./bar-cache.js";
import { benchmark, betaReturns, dailyBeta } from "./beta.js";
import { normalize, type PriceBar, type RawBar } from "./bars.js";
import {
  baselineCounts,
  OutcomeScorer,
  parseValidation,
  summarize,
  ValidationInputError,
  type BaselineCounts,
  type Outcome,
  type ValidationConfig,
  type ValidationSummary,
} from "./outcome.js";
import { coreClose, previousSessions } from "./calendar.js";
import { LiveEvaluator } from "./evaluator.js";
import { backtestLimits, maxSymbolsPerRequest } from "./backtest-limits.js";
import type { ResultCache } from "./result-cache.js";

export { backtestLimits, maxSymbolsPerRequest };
export const tickerPattern = /^[A-Z][A-Z0-9. -]{0,9}$/;
export { parseSipDelay, sipDelayMs } from "./sip-delay.js";

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
  // Marked-sections score vs SPY at the alert's end minute, as the live
  // alert computes it (docs/features/marks-vs-spy.md). Absent in results
  // stored before the alert score vs SPY.
  vsSpy?: AlertVsSpy;
  outcome: Outcome; // trade view: stop/target in the alert's direction
  lookNow: LookNow; // main grade: how unusual the move after the alert was
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
  // runBacktest always sets `validation.baselineBySymbol`; the type keeps it
  // optional because merged or older-API results may lack it.
  validation: ValidationSummary;
  lookNow: LookNowSummary;
  cache?: CacheStats; // symbol-days served from the bar cache vs fetched
  // Symbols whose computed part came from the result cache vs were computed.
  results?: { hits: number; misses: number };
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

// `limited` applies the Worker's request limits; the offline backtest script
// (no memory or CPU cap) turns them off.
export function parseBacktest(input: unknown, now: number, limited = true) {
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
    (limited && tickers.length > backtestLimits.tickers) ||
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
      `Dates, including ${config.days} warmup sessions before the start, must fall within 2024–2028`,
    );
  }
  if (sessions.length < 1)
    throw new BacktestInputError("The range contains no trading sessions");
  if (limited && sessions.length > backtestLimits.sessions)
    throw new BacktestInputError(
      `Choose at most ${backtestLimits.sessions} trading sessions`,
    );
  // Settings errors start with "Choose" so the page stops instead of retrying.
  const fit = maxSymbolsPerRequest(sessions.length, config.days);
  if (limited && tickers.length > fit)
    throw new BacktestInputError(
      fit < 1
        ? `Choose a shorter range: ${sessions.length} sessions plus ${config.days} warmup sessions do not fit one request`
        : `Choose at most ${fit} symbols per request for ${sessions.length} sessions`,
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

export type BacktestRequest = ReturnType<typeof parseBacktest>;

/**
 * Bars after `end` are not final yet (`delayMinutes`: see sip-delay.ts);
 * context needs β from `betaStart`.
 */
export function backtestWindow(
  request: BacktestRequest,
  now: number,
  delayMinutes?: number,
) {
  const next = new Date(`${request.to}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  // 06:00Z is after the latest post-market close (01:00Z in winter) and
  // before the next pre-market; later bars are filtered by date anyway.
  const final = Date.parse(`${next.toISOString().slice(0, 10)}T06:00:00Z`);
  const end = Math.min(final, now - sipDelayMs(delayMinutes));
  let betaStart: string | null = null;
  try {
    betaStart = previousSessions(request.from, betaReturns + 1)[0]!;
  } catch {
    // Outside calendar coverage: alerts carry no market context.
  }
  return {
    end,
    // Every bar of the range is final, so its results may be cached.
    complete: end === final,
    // Minute bars from the first warmup session: the look-now score's normal
    // moves are market-adjusted on past days too.
    start: `${request.warmup[0]}T00:00:00Z`,
    until: new Date(end).toISOString(),
    betaStart,
  };
}
export type BacktestWindow = ReturnType<typeof backtestWindow>;

/** One symbol's computed share of a run; plain data, so it can be cached. */
export interface SymbolPart {
  ticker: string;
  evaluated: number;
  diagnostics: Record<string, number>;
  alerts: {
    alert: BacktestAlert; // lookNow is filled in by finish()
    measured: ReturnType<LookNowScorer["measure"]>;
    beta: { beta: number; assumed: boolean };
    closeMinute: number;
    minute: number;
  }[];
  baseline: BaselineCounts;
  randoms: number[][]; // RandomMinutes columns
  coverage: BacktestResult["coverage"][number];
}

// JSON for a cached SymbolPart. JSON has no NaN/Infinity (random-minute
// columns use NaN), so non-finite numbers are tagged.
export const encodePart = (part: SymbolPart) =>
  JSON.stringify(part, (_k, v) =>
    typeof v === "number" && !Number.isFinite(v) ? { $num: String(v) } : v,
  );
export const decodePart = (text: string): SymbolPart =>
  JSON.parse(text, (_k, v) =>
    v && typeof v === "object" && "$num" in v ? Number(v.$num) : v,
  );

/**
 * One backtest fed a symbol at a time, so a long run never holds every
 * symbol's bars at once. Look-now scores are ranked against the random minutes
 * of all symbols in `finish`.
 */
export class BacktestRun {
  private readonly spy: MarketTrack;
  private readonly spyBars: PriceBar[];
  private readonly outcomes: Outcome[] = [];
  private readonly baseline: BaselineCounts = {
    scored: 0,
    good: 0,
    stopped: 0,
    weak: 0,
  };
  private readonly baselineBySymbol: Record<string, BaselineCounts> = {};
  private readonly pending: SymbolPart["alerts"] = [];
  private readonly randoms = new RandomMinutes();
  private readonly alerts: BacktestAlert[] = [];
  private readonly diagnostics: Record<string, number> = {};
  private readonly coverage: BacktestResult["coverage"] = [];
  private evaluated = 0;

  constructor(
    private readonly request: BacktestRequest,
    private readonly window: BacktestWindow,
    spyRows: RawBar[],
    private readonly spyDaily: RawBar[],
  ) {
    this.spy = marketTrack(benchmark, spyRows);
    this.spyBars = spyRows
      .map((row) => normalize(benchmark, row, "shares"))
      .filter((b): b is PriceBar => b !== null);
    for (const bar of this.spyBars) {
      const day = this.spyDays.get(bar.date);
      if (day) day.push(fromPriceBar(bar));
      else this.spyDays.set(bar.date, [fromPriceBar(bar)]);
    }
  }
  // SPY's bars per New York date, for the score vs SPY.
  private readonly spyDays = new Map<string, MarkBar[]>();

  /** Replays one symbol's minute bars (from `window.start`) and daily bars. */
  add(ticker: string, rows: RawBar[], daily: RawBar[]) {
    this.merge(this.compute(ticker, rows, daily));
  }

  /**
   * One symbol's share of the run, independent of the other symbols, so it can
   * be cached. Look-now scores are left for `finish`.
   */
  compute(ticker: string, rows: RawBar[], daily: RawBar[]): SymbolPart {
    const { from, to, config, sessions, validation } = this.request;
    const { end, betaStart } = this.window;
    const evaluator = new LiveEvaluator(config);
    const seen = new Set<string>();
    const lastRegular = new Map<string, number>();
    const normalized: PriceBar[] = [];
    const tickerAlerts: BacktestAlert[] = [];
    const diagnostics: Record<string, number> = {};
    // β/σ vs SPY per alert date, from the daily bars already loaded.
    const strengths = new Map<string, SpyStrength | null>();
    const strengthOf = (date: string) => {
      if (!betaStart) return null;
      if (!strengths.has(date)) {
        let value: SpyStrength | null = null;
        try {
          value = spyStrength(
            previousSessions(date, betaReturns + 1),
            daily,
            this.spyDaily,
          );
        } catch {
          // Outside calendar coverage: no score.
        }
        strengths.set(date, value);
      }
      return strengths.get(date)!;
    };
    // Score vs SPY: the stock's bars per date as index ranges into
    // `normalized` (bars so far: no look-ahead), β-free marks of completed
    // past dates (memoized), and a σ curve per alert date.
    const dayStart = new Map<string, number>();
    const barsOf = (date: string) => {
      const from = dayStart.get(date);
      if (from === undefined) return [];
      const result: MarkBar[] = [];
      for (let i = from; i < normalized.length; i++) {
        if (normalized[i]!.date !== date) break;
        result.push(fromPriceBar(normalized[i]!));
      }
      return result;
    };
    const previousOf = (date: string) => {
      try {
        return previousSessions(date, 1)[0]!;
      } catch {
        return null;
      }
    };
    // The date's bars and the previous session's (its close).
    const withPrevious = (date: string) => {
      const previous = previousOf(date);
      return previous ? [...barsOf(previous), ...barsOf(date)] : barsOf(date);
    };
    const spyWithPrevious = (date: string) => {
      const previous = previousOf(date);
      return [
        ...((previous && this.spyDays.get(previous)) || []),
        ...(this.spyDays.get(date) ?? []),
      ];
    };
    const marks = new Map<string, DayMarks | null>();
    const pastMarks = (date: string) => {
      if (!marks.has(date)) {
        const previous = previousOf(date);
        const days = new Map<string, MarkBar[]>([[date, barsOf(date)]]);
        if (previous) days.set(previous, barsOf(previous));
        marks.set(date, historyMarks(ticker, days, this.spyDays, date));
      }
      return marks.get(date)!;
    };
    const sigmas = new Map<string, MarksSigma | null>();
    const sigmaOf = (date: string, beta: number) => {
      if (!sigmas.has(date)) {
        let value: MarksSigma | null = null;
        try {
          value = sigmaCurve(
            pastMarks,
            previousSessions(date, marksSigmaSessions),
            beta,
          );
        } catch {
          // Outside calendar coverage: no σ.
        }
        sigmas.set(date, value);
      }
      return sigmas.get(date)!;
    };
    const vsSpyAt = (bar: PriceBar) => {
      const strength = strengthOf(bar.date);
      const beta = strength?.beta ?? 1;
      return alertVsSpy({
        ticker,
        date: bar.date,
        minute: bar.minute - 1,
        window: config.window,
        stock: withPrevious(bar.date),
        spy: spyWithPrevious(bar.date),
        beta,
        betaAssumed: strength?.betaAssumed ?? true,
        sigma: ticker === benchmark ? null : sigmaOf(bar.date, beta),
      });
    };
    let evaluated = 0;
    let count = 0;
    for (const row of rows) {
      const bar = normalize(ticker, row, "shares");
      if (!bar || bar.date > to || Date.parse(bar.end) > end) continue;
      if (!dayStart.has(bar.date)) dayStart.set(bar.date, normalized.length);
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
          lookNow: undefined as unknown as LookNow, // scored in finish()
          vsSpy: vsSpyAt(bar),
          context:
            ticker === benchmark || !betaStart
              ? null
              : context(
                  bar.date,
                  Date.parse(bar.end),
                  bar.close,
                  lastRegular,
                  this.spy,
                  daily,
                  this.spyDaily,
                ),
        });
    }
    // Outcomes need the bars after each alert, so score once all are read.
    const scorer = new OutcomeScorer(normalized, validation);
    const betas = new Map<string, number | null>();
    const betaOf = (date: string) => {
      if (ticker === benchmark) return 0;
      if (!betaStart) return null;
      if (!betas.has(date)) {
        let value: number | null = null;
        try {
          value = dailyBeta(
            previousSessions(date, betaReturns + 1),
            daily,
            this.spyDaily,
          ).value;
        } catch {
          // Outside calendar coverage: β is assumed.
        }
        betas.set(date, value);
      }
      return betas.get(date)!;
    };
    const byEnd = new Map(normalized.map((b) => [b.end, b]));
    const look = new LookNowScorer(
      normalized,
      ticker === benchmark ? null : this.spyBars,
      betaOf,
    );
    const alerts = tickerAlerts.map((alert) => {
      alert.outcome = scorer.score(alert.end, alert.direction ?? "up");
      const minute = byEnd.get(alert.end)!;
      return {
        alert,
        measured: look.measure(minute.date, minute.minute, minute.session),
        beta: look.betaInfo(minute.date),
        closeMinute: minute.regularClose ?? 960,
        minute: minute.minute,
      };
    });
    const randoms = new RandomMinutes();
    for (const r of look.baseline(from, to)) randoms.add(r.measured);
    return {
      ticker,
      evaluated,
      diagnostics,
      alerts,
      baseline: baselineCounts(scorer.baseline(from, to)),
      randoms: randoms.columns(),
      coverage: {
        ticker,
        bars: count,
        missingSessions: sessions.filter(
          (date) => !seen.has(date) && Date.parse(`${date}T13:30:00Z`) < end,
        ),
      },
    };
  }

  merge(part: SymbolPart) {
    this.evaluated += part.evaluated;
    for (const [status, n] of Object.entries(part.diagnostics))
      this.diagnostics[status] = (this.diagnostics[status] ?? 0) + n;
    for (const p of part.alerts) {
      this.outcomes.push(p.alert.outcome);
      this.alerts.push(p.alert);
      this.pending.push(p);
    }
    this.baselineBySymbol[part.ticker] = part.baseline;
    for (const k of ["scored", "good", "stopped", "weak"] as const)
      this.baseline[k] += part.baseline[k];
    this.randoms.addColumns(part.randoms);
    this.coverage.push(part.coverage);
  }

  finish(): BacktestResult {
    const { tickers, from, to, config, validation } = this.request;
    const rank = this.randoms.ranks();
    for (const p of this.pending)
      p.alert.lookNow = lookNow(
        p.measured,
        p.alert.direction,
        rank,
        p.beta,
        p.closeMinute,
        p.minute,
      );
    const alerts = [...this.alerts].sort(
      (a, b) => a.end.localeCompare(b.end) || a.ticker.localeCompare(b.ticker),
    );
    return {
      source: "alpaca",
      feed: "sip",
      tickers,
      from,
      to,
      config,
      evaluated: this.evaluated,
      alerts,
      diagnostics: this.diagnostics,
      coverage: this.coverage,
      validation: {
        ...summarize(this.outcomes, [], validation),
        baseline: { ...this.baseline },
        baselineBySymbol: this.baselineBySymbol,
      },
      lookNow: summarizeLookNow(
        alerts.map((a) => a.lookNow),
        this.randoms.scores(rank),
      ),
    };
  }
}

// Replays Alpaca minute bars through the live evaluator, as if each bar had
// been received the moment it closed. Warmup bars build the baseline only.
// With `results`, symbols already computed for the same rule, code, dates and
// settings are loaded instead of replayed (only when the range is final).
export async function runBacktest(
  input: unknown,
  history: History,
  now = Date.now(),
  daily: History = async () => [],
  results?: ResultCache,
  delayMinutes?: number,
): Promise<BacktestResult> {
  const request = parseBacktest(input, now);
  const window = backtestWindow(request, now, delayMinutes);
  const { tickers, to } = request;
  const { start, until, betaStart } = window;
  const cache = results && window.complete ? results : undefined;
  const keys = cache
    ? await Promise.all(tickers.map((t) => cache.partKey(request, window, t)))
    : [];
  let cached = new Map<string, SymbolPart>();
  try {
    if (cache) cached = await cache.getParts(keys);
  } catch {
    // An unreadable cache only costs time: compute everything.
  }
  const missing = tickers.filter((_, i) => !cached.has(keys[i]!));
  const others = tickers.filter((t) => t !== benchmark);
  const market = missing.length > 0 && others.length > 0 && betaStart !== null;
  const [rows, spyRows, dailyRows] = await Promise.all([
    Promise.all(missing.map((ticker) => history(ticker, start, until))),
    market ? history(benchmark, start, until) : [],
    market
      ? Promise.all(
          [...others, benchmark].map((t) =>
            missing.includes(t) || t === benchmark
              ? daily(t, `${betaStart}T00:00:00Z`, `${to}T00:00:00Z`)
              : [],
          ),
        )
      : [],
  ]);
  const dailyBy = new Map(
    [...others, benchmark].map((t, i) => [t, dailyRows[i] ?? []]),
  );
  const run = new BacktestRun(
    request,
    window,
    spyRows,
    dailyBy.get(benchmark)!,
  );
  const computed: { key: string; part: SymbolPart }[] = [];
  tickers.forEach((ticker, i) => {
    const hit = cached.get(keys[i]!);
    if (hit) return run.merge(hit);
    const part = run.compute(
      ticker,
      rows[missing.indexOf(ticker)]!,
      dailyBy.get(ticker)!,
    );
    if (cache) computed.push({ key: keys[i]!, part });
    run.merge(part);
  });
  try {
    if (cache) await cache.putParts(computed);
  } catch {
    // Not cached this time; the result is still correct.
  }
  const result = run.finish();
  return cache
    ? { ...result, results: { hits: cached.size, misses: missing.length } }
    : result;
}

export interface Credentials {
  key?: string;
  secret?: string;
  // ALPACA_SIP_DELAY_MINUTES (sip-delay.ts); unset → the default.
  sipDelayMinutes?: number;
}

// Shared by the local API and the hosted Worker so both behave identically.
/** Minute-bar history through the cache when one is configured. */
export function minuteHistory(
  feed: AlpacaFeed,
  cache: BarCache | undefined,
  now: number,
  stats?: CacheStats,
  delayMinutes?: number,
): History {
  return (ticker, start, end) =>
    cache
      ? cachedHistory(
          `${ticker}:sip:1Min:raw`,
          start,
          end,
          (s, e) => feed.history(ticker, s, e),
          cache,
          now - sipDelayMs(delayMinutes),
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
  results?: ResultCache,
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
      minuteHistory(feed, cache, now, stats, credentials.sipDelayMinutes),
      now,
      (ticker, start, end) => feed.history(ticker, start, end, "1Day", "split"),
      results,
      credentials.sipDelayMinutes,
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
