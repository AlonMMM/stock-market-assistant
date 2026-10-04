import { AlpacaFeed } from "./alpaca.js";
import {
  minuteHistory,
  tickerPattern,
  type Credentials,
  type History,
} from "./backtest.js";
import type { BarCache } from "./bar-cache.js";
import type { AreaVsSpySeries } from "../../contracts/src/vs-spy.js";
import { areaSeries, fromRawBars } from "./area-vs-spy.js";
import { areaSigmas, type AreaSigmaStore } from "./area-sigma.js";
import { benchmark, betaReturns, dailyBeta } from "./beta.js";
import { normalize, type RawBar } from "./bars.js";
import { coreClose, previousSessions } from "./calendar.js";
import { spyStrength, type SpyStrength } from "./rs-score.js";
import { defaultSipDelayMinutes, sipDelayMs } from "./sip-delay.js";

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
  // Requested ticker only, aligned with `bars`: median volume at the same New
  // York minute and session over the previous 20 sessions; null with < 15.
  typicalVolume?: (number | null)[];
}

export interface DayChart {
  source: "alpaca";
  feed: "sip";
  // Minutes the data may lag real time (ALPACA_SIP_DELAY_MINUTES); 0 = live.
  delayMinutes?: number;
  date: string;
  series: ChartSeries[]; // requested ticker first, then the benchmark
  // Ticker beta vs the chart's benchmark (series[1]); null for the benchmark
  // itself or with too few paired returns.
  beta: { value: number | null; returns: number; lookback: number };
  // Day-based score inputs (docs/features/chart-vs-spy.md), always against
  // SPY. SPY's minute series is the entry of `series` whose ticker is "SPY";
  // when no entry is SPY (sector benchmark), it is carried in `spy` instead.
  // Deprecated by `areaVsSpy`; kept until the web reads the area series.
  vsSpy?: VsSpy;
  // Area score vs SPY per bar of the requested ticker
  // (docs/features/area-vs-spy.md): gap pane, per-minute score, σ, window
  // starts and β. Absent for SPY itself or without SPY's minute bars.
  areaVsSpy?: AreaVsSpySeries;
}

export interface VsSpy extends SpyStrength {
  // SPY's day series (no typicalVolume); only when `series` has no SPY entry.
  spy?: ChartSeries;
}

export class DayChartInputError extends Error {}

// Typical volume baseline: previous sessions examined and the minimum with a
// bar at the same minute (docs/features/live-page.md).
export const typicalVolumeSessions = 20;
export const typicalVolumeMinimum = 15;

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Per bar of `date`: the median volume of the bars at the same New York minute
 * and session over the previous sessions in `baseline`; null with fewer than
 * `typicalVolumeMinimum` such bars. Only earlier dates contribute.
 */
export function typicalVolumes(
  ticker: string,
  rows: RawBar[],
  date: string,
  baseline: string[],
): (number | null)[] {
  const prior = new Set(baseline.filter((d) => d < date));
  const history = new Map<string, number[]>();
  const today: string[] = [];
  for (const row of rows) {
    const bar = normalize(ticker, row, "shares");
    if (!bar) continue;
    const key = `${bar.session}|${bar.minute}`;
    if (bar.date === date) today.push(key);
    else if (prior.has(bar.date)) {
      const list = history.get(key);
      if (list) list.push(bar.volume);
      else history.set(key, [bar.volume]);
    }
  }
  return today.map((key) => {
    const volumes = history.get(key);
    return volumes && volumes.length >= typicalVolumeMinimum
      ? median(volumes)
      : null;
  });
}

function parse(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new DayChartInputError("Expected JSON object");
  const {
    ticker,
    date,
    benchmark: against = benchmark,
  } = input as { ticker?: unknown; date?: unknown; benchmark?: unknown };
  if (typeof ticker !== "string" || !tickerPattern.test(ticker))
    throw new DayChartInputError("Choose one US stock symbol");
  if (typeof against !== "string" || !tickerPattern.test(against))
    throw new DayChartInputError("Choose one US benchmark symbol");
  let open: boolean;
  try {
    open =
      typeof date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      coreClose(date) !== null;
  } catch {
    open = false;
  }
  if (!open) throw new DayChartInputError("Choose a 2024–2028 US trading day");
  return { ticker, date: date as string, against };
}

// One trading day of minute bars (pre-market through after-hours) for a ticker
// and SPY, each symbol's previous regular close, and the ticker's beta.
export async function runDayChart(
  input: unknown,
  history: History,
  now = Date.now(),
  daily: History = async () => [],
  delayMinutes = defaultSipDelayMinutes,
  sigmas?: AreaSigmaStore,
): Promise<DayChart> {
  const { ticker, date, against } = parse(input);
  let previous: string;
  try {
    previous = previousSessions(date, 1)[0]!;
  } catch {
    throw new DayChartInputError("Choose a 2024–2028 US trading day");
  }
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const end = Math.min(
    Date.parse(`${next.toISOString().slice(0, 10)}T06:00:00Z`),
    now - sipDelayMs(delayMinutes),
  );
  const start = `${previous}T00:00:00Z`;
  if (Date.parse(start) >= end)
    throw new DayChartInputError("That day has no data yet");
  const tickers = ticker === against ? [ticker] : [ticker, against];
  // The requested ticker's history reaches back over the typical-volume
  // baseline; finished days come from the bar cache when one is configured.
  let baseline: string[] = [];
  try {
    baseline = previousSessions(date, typicalVolumeSessions);
  } catch {
    // Outside calendar coverage: typical volume is reported as unavailable.
  }
  const tickerStart = baseline.length ? `${baseline[0]}T00:00:00Z` : start;
  let betaSessions: string[] = [];
  try {
    betaSessions = previousSessions(date, betaReturns + 1);
  } catch {
    // Outside calendar coverage: beta is reported as unavailable.
  }
  // Daily bars are requested once per symbol and shared by the benchmark β
  // and the vs-SPY β/σ. They end at the chart day's midnight UTC, before its
  // daily bar: no look-ahead.
  const dailyRequests = new Map<string, Promise<RawBar[]>>();
  const dailyOf = (t: string) => {
    let request = dailyRequests.get(t);
    if (!request) {
      request = daily(t, `${betaSessions[0]}T00:00:00Z`, `${date}T00:00:00Z`);
      dailyRequests.set(t, request);
    }
    return request;
  };
  const endIso = new Date(end).toISOString();
  const spyMissing = !tickers.includes(benchmark);
  const [rows, dailyRows, spyDaily, spyRows] = await Promise.all([
    Promise.all(
      tickers.map((t, index) =>
        history(t, index ? start : tickerStart, endIso),
      ),
    ),
    tickers.length === 2 && betaSessions.length > 0
      ? Promise.all(tickers.map(dailyOf))
      : null,
    // vs SPY: failures degrade to β assumed / no σ, never fail the chart.
    betaSessions.length > 0
      ? Promise.all([dailyOf(ticker), dailyOf(benchmark)]).catch(() => null)
      : null,
    spyMissing ? history(benchmark, start, endIso).catch(() => null) : null,
  ]);
  const beta = dailyRows
    ? dailyBeta(betaSessions, dailyRows[0]!, dailyRows[1]!)
    : { value: null, returns: 0 };
  const toSeries = (t: string, raw: RawBar[]): ChartSeries => {
    const bars: ChartBar[] = [];
    let previousClose: number | null = null;
    for (const row of raw) {
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
  };
  const chart: DayChart = {
    source: "alpaca",
    feed: "sip",
    delayMinutes,
    date,
    beta: { ...beta, lookback: betaReturns },
    series: tickers.map((t, index) => {
      const series = toSeries(t, rows[index]!);
      if (index > 0) return series;
      return {
        ...series,
        typicalVolume: typicalVolumes(t, rows[0]!, date, baseline),
      };
    }),
  };
  // Without SPY's minute bars no score can be shown: vsSpy is left out.
  if (!spyMissing || spyRows) {
    const strength: SpyStrength = spyDaily
      ? spyStrength(betaSessions, spyDaily[0], spyDaily[1])
      : { beta: 1, betaAssumed: true, betaReturns: 0, sigma: null };
    chart.vsSpy = spyRows
      ? { ...strength, spy: toSeries(benchmark, spyRows) }
      : strength;
    if (ticker !== benchmark) {
      // σ curve: stored per (date, ticker), else from the ticker's history
      // already loaded and SPY's previous 20 sessions (bar cache).
      const loaded = rows[0]!;
      const curves = await areaSigmas(
        [ticker],
        date,
        () => strength.beta,
        (t, from, to) =>
          t === ticker
            ? Promise.resolve(
                loaded.filter(
                  (r) =>
                    r.start * 1000 >= Date.parse(from) &&
                    r.start * 1000 < Date.parse(to),
                ),
              )
            : history(t, from, to),
        sigmas,
      );
      const stock = fromRawBars(ticker, loaded).filter((b) => b.date === date);
      const spy = fromRawBars(
        benchmark,
        spyRows ?? rows[tickers.indexOf(benchmark)]!,
      ).filter((b) => b.date === date);
      chart.areaVsSpy = {
        ...areaSeries(
          {
            ticker,
            stock,
            spy,
            date,
            beta: strength.beta,
            sigma: curves.get(ticker) ?? null,
          },
          stock,
        ),
        beta: strength.beta,
        betaAssumed: strength.betaAssumed,
      };
    }
  }
  return chart;
}

// Shared by the local API and the hosted Worker so both behave identically.
export async function handleDayChart(
  body: unknown,
  credentials: Credentials,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  cache?: BarCache,
  sigmas?: AreaSigmaStore,
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
        minuteHistory(feed, cache, now, undefined, credentials.sipDelayMinutes),
        now,
        (ticker, start, end) =>
          feed.history(ticker, start, end, "1Day", "split"),
        credentials.sipDelayMinutes,
        sigmas,
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
