import { AlpacaFeed, type AlpacaTrade } from "./alpaca.js";
import { minuteHistory, tickerPattern, type Credentials } from "./backtest.js";
import type { BarCache, CacheStats } from "./bar-cache.js";
import {
  AlpacaBacktestData,
  backtestCalendar,
  firstBacktestDate,
  lastFinishedSession,
  maxBacktestSessions,
  splitDays,
} from "./bot-backtest.js";
import {
  coreClose,
  newYorkToUtc,
  nextSessions,
  previousSessions,
} from "./calendar.js";
import type { OptionBarStore } from "./option-bars.js";
import type { OptionQuoteStore } from "./option-quotes.js";
import { TradeBarBuilder } from "./trade-bars.js";
import type { VolumeDataStore } from "./volume-data.js";
import {
  defaultVolumeFillPct,
  runVolumeStock,
  type SecondBook,
  type ShockAlert,
  type VolumeBacktestData,
  type VolumeStockRun,
} from "../../trading/src/strangle/backtest.js";
import {
  defaultStrangleSettings,
  parseStrangleSettings,
} from "../../trading/src/strangle/settings.js";

// POST /api/volume-backtest: the Volume bot's backtest of one stock over a
// range of sessions (strangle/backtest.ts), as /api/bot-backtest serves the
// Main bot's: the page sends one request a stock and a long range in parts,
// with the settings to test; the account is applied on the page
// (volumeAccount). Stock bars go through the bar cache; the shock alerts and
// the 1-second windows come from D1 (volume-data.ts), a stock window missing
// there from Alpaca's trades (then kept); option chains, bars and real quotes
// as the Main bot's backtest reads them.

export interface VolumeBacktestResponse extends VolumeStockRun {
  from: string;
  to: string;
  lastSession: string;
  fillPct: number;
  cache?: CacheStats;
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

class InputError extends Error {}

function parseRequest(body: unknown, lastSession: string) {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new InputError("Expected a JSON object");
  const b = body as Record<string, unknown>;
  const symbol =
    typeof b.symbol === "string" ? b.symbol.trim().toUpperCase() : "";
  if (!tickerPattern.test(symbol) || symbol === "SPY")
    throw new InputError("symbol must be a stock ticker other than SPY");
  const from = typeof b.from === "string" ? b.from : "";
  const to = typeof b.to === "string" ? b.to : "";
  if (!datePattern.test(from) || !datePattern.test(to) || from > to)
    throw new InputError("from and to must be dates, from first");
  if (from < firstBacktestDate)
    throw new InputError(`Option data starts on ${firstBacktestDate}`);
  if (to > lastSession)
    throw new InputError(`The last session with final data is ${lastSession}`);
  // Back from `to` one session at a time: the calendar starts in 2024.
  const dates: string[] = [];
  for (
    let d = to;
    d >= from && dates.length <= maxBacktestSessions;
    d = previousSessions(d, 1)[0]!
  )
    if (coreClose(d) !== null) dates.unshift(d);
  if (!dates.length) throw new InputError("No sessions in the range");
  if (dates.length > maxBacktestSessions)
    throw new InputError(`At most ${maxBacktestSessions} sessions a request`);
  // The page's settings over the defaults; the stock list is the request's.
  const given =
    typeof b.settings === "object" && b.settings !== null
      ? (b.settings as Record<string, unknown>)
      : {};
  const parsed = parseStrangleSettings({
    ...defaultStrangleSettings,
    ...given,
    added: [],
    off: [],
    mode: "dry",
  });
  if (!parsed.ok) throw new InputError(parsed.error);
  let fillPct = defaultVolumeFillPct;
  if (b.fillPct !== undefined) {
    if (typeof b.fillPct !== "number" || !(b.fillPct >= 0 && b.fillPct <= 10))
      throw new InputError("fillPct must be a number from 0 to 10");
    fillPct = b.fillPct;
  }
  return { symbol, dates, settings: parsed.value, fillPct };
}

/** The last trade price each second of [from, to] (session seconds) from a run of trades, by Alpaca's bar rules. */
export function secondsFromTrades(
  trades: readonly AlpacaTrade[],
  openMs: number,
  from: number,
  to: number,
): [number, number][] {
  const builder = new TradeBarBuilder(
    1,
    openMs + from * 1000,
    openMs + (to + 1) * 1000,
  );
  for (const t of trades)
    builder.add({
      time: Date.parse(t.t),
      price: t.p,
      size: t.s,
      conditions: t.c ?? [],
      tape: t.z ?? "",
      ...(t.u ? { correction: t.u } : {}),
    });
  return builder
    .bars()
    .map((b) => [b.start - openMs / 1000, b.close] as [number, number]);
}

/** The Main bot's backtest data, with the Volume bot's seconds and alerts. */
export class AlpacaVolumeData
  extends AlpacaBacktestData
  implements VolumeBacktestData
{
  constructor(
    stocks: Map<string, ReturnType<typeof splitDays>>,
    lastSession: string,
    credentials: { key: string; secret: string },
    tradingUrl: string,
    fetcher: typeof fetch,
    private readonly feed: AlpacaFeed,
    quotes?: OptionQuoteStore,
    optionStore?: OptionBarStore,
    private readonly store?: VolumeDataStore,
  ) {
    super(
      stocks,
      lastSession,
      credentials,
      tradingUrl,
      fetcher,
      quotes,
      optionStore,
    );
  }

  async stockSeconds(
    symbol: string,
    date: string,
    from: number,
    to: number,
  ): Promise<[number, number][]> {
    const stored = await this.store
      ?.stock(symbol, date, from, to)
      .catch(() => null);
    if (stored) return stored;
    const openMs = newYorkToUtc(date, 570);
    const trades: AlpacaTrade[] = [];
    for await (const page of this.feed.trades(
      symbol,
      new Date(openMs + from * 1000).toISOString(),
      new Date(openMs + (to + 1) * 1000).toISOString(),
    ))
      trades.push(...page);
    const rows = secondsFromTrades(trades, openMs, from, to);
    if (date <= this.lastSession)
      await this.store?.putStock(symbol, date, from, to, rows).catch(() => {});
    return rows;
  }

  async optionSeconds(
    contract: string,
    date: string,
    from: number,
    to: number,
  ): Promise<SecondBook[]> {
    return this.store
      ? this.store.option(contract, date, from, to).catch(() => [])
      : [];
  }

  async shockAlerts(
    symbol: string,
    from: string,
    to: string,
  ): Promise<ShockAlert[]> {
    return this.store ? this.store.shocks(symbol, from, to) : [];
  }
}

export async function handleVolumeBacktest(
  body: unknown,
  credentials: Credentials,
  tradingUrl: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  cache?: BarCache,
  quotes?: OptionQuoteStore,
  optionStore?: OptionBarStore,
  store?: VolumeDataStore,
): Promise<{
  status: number;
  body: VolumeBacktestResponse | { error: string };
}> {
  if (!credentials.key || !credentials.secret)
    return {
      status: 503,
      body: { error: "Alpaca credentials are not configured on the server" },
    };
  const lastSession = lastFinishedSession(now, credentials.sipDelayMinutes);
  let request: ReturnType<typeof parseRequest>;
  try {
    request = parseRequest(body, lastSession);
  } catch (error) {
    if (error instanceof InputError)
      return { status: 400, body: { error: error.message } };
    throw error;
  }
  const { symbol, dates, settings, fillPct } = request;
  const feed = new AlpacaFeed(
    credentials.key,
    credentials.secret,
    "sip",
    () => {},
    fetcher,
  );
  const stats: CacheStats = { hits: 0, misses: 0 };
  const history = minuteHistory(
    feed,
    cache,
    now,
    stats,
    credentials.sipDelayMinutes,
  );
  // The 20 sessions before the first date (the alert's history), midnight to
  // midnight New York so the pre-market is in the cached days too.
  const first = backtestCalendar.previousSessions(dates[0]!, 20)[0]!;
  const start = new Date(newYorkToUtc(first, 0)).toISOString();
  const end = new Date(
    newYorkToUtc(nextSessions(dates.at(-1)!, 1)[0]!, 0),
  ).toISOString();
  try {
    const stocks = new Map([
      [symbol, splitDays(await history(symbol, start, end))],
    ]);
    const data = new AlpacaVolumeData(
      stocks,
      lastSession,
      { key: credentials.key, secret: credentials.secret },
      tradingUrl,
      fetcher,
      feed,
      quotes,
      optionStore,
      store,
    );
    const run = await runVolumeStock(
      symbol,
      dates,
      settings,
      data,
      backtestCalendar,
      // Real books only (the user, 2026-11-01: "stop fallback as we have the
      // data now"): a buy needs its 1-second book, a sale its minute book;
      // without them the alert is not traded, as in the research simulator.
      { fillPct, strictQuotes: true },
    );
    return {
      status: 200,
      body: {
        ...run,
        from: dates[0]!,
        to: dates.at(-1)!,
        lastSession,
        fillPct,
        ...(cache ? { cache: stats } : {}),
      },
    };
  } catch (error) {
    // Adapter errors carry only status codes, never credentials or bodies.
    const message =
      error instanceof Error && error.message.startsWith("Alpaca")
        ? error.message
        : "Market data failed";
    return { status: 502, body: { error: message } };
  }
}
