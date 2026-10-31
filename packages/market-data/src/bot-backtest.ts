import { AlpacaFeed } from "./alpaca.js";
import { minuteHistory, tickerPattern, type Credentials } from "./backtest.js";
import type { BarCache, CacheStats } from "./bar-cache.js";
import type { OptionQuoteStore } from "./option-quotes.js";
import type { OptionBarStore } from "./option-bars.js";
import type { RawBar } from "./bars.js";
import {
  coreClose,
  newYork,
  newYorkToUtc,
  nextSessions,
  previousSessions,
} from "./calendar.js";
import { sipDelayMs } from "./sip-delay.js";
import {
  dataWindow,
  defaultFillPct,
  runStock,
  type BacktestCalendar,
  type BacktestData,
  type ChainContract,
  type QuoteMinute,
  type StockRun,
} from "../../trading/src/bot/backtest.js";
import { nasdaqEarnings } from "../../trading/src/bot/nasdaq.js";
import type { EarningsReport } from "../../trading/src/bot/news.js";
import {
  defaultSettings,
  parseSettings,
} from "../../trading/src/bot/settings.js";
import { ruleKeys } from "../../trading/src/bot/versions.js";
import type { MinuteBar } from "../../trading/src/bot/signal.js";

// POST /api/bot-backtest: the Main bot's backtest of one stock over a range of
// sessions (the Backtest page sends one request a stock, and a long range in
// parts). The rules come with the request (a version's, or changed on the
// page); the account is applied on the page (backtest-account.ts). Stock bars
// go through the bar cache; option chains and bars, and the earnings
// calendar, are read for the signals only.

/** Alpaca's option bars start in February 2024. */
export const firstBacktestDate = "2024-02-01";
/** Sessions one request may cover; the page splits a longer range. */
export const maxBacktestSessions = 60;

export interface BotBacktestResponse extends StockRun {
  from: string;
  to: string;
  lastSession: string;
  fillPct: number;
  cache?: CacheStats;
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const dataUrl = "https://data.alpaca.markets";

export const backtestCalendar: BacktestCalendar = {
  sessionLength(date) {
    const close = coreClose(date);
    return close === null ? null : close - 570;
  },
  previousSessions,
  nextSessions,
};

/** The last session whose data is final at `now`. */
export function lastFinishedSession(
  now: number,
  delayMinutes?: number,
): string {
  const ny = newYork(now - sipDelayMs(delayMinutes));
  const close = coreClose(ny.date);
  if (close !== null && ny.minute >= close) return ny.date;
  return previousSessions(ny.date, 1)[0]!;
}

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
  // Back from `to` one session at a time: the calendar starts in 2024, so a
  // fixed count back (400 sessions) failed for an early-2024 range.
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
  // Only the rules come from the page; the owner's other settings stay the defaults.
  const rules =
    typeof b.rules === "object" && b.rules !== null
      ? (b.rules as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = { ...defaultSettings };
  for (const key of ruleKeys) if (key in rules) merged[key] = rules[key];
  const parsed = parseSettings(merged);
  if (!parsed.ok) throw new InputError(parsed.error);
  let fillPct = defaultFillPct;
  if (b.fillPct !== undefined) {
    if (typeof b.fillPct !== "number" || !(b.fillPct >= 0 && b.fillPct <= 10))
      throw new InputError("fillPct must be a number from 0 to 10");
    fillPct = b.fillPct;
  }
  return { symbol, dates, settings: parsed.value, fillPct };
}

/** Regular-session minutes by date, and the pre-market volume (04:00–09:30) by date. */
export function splitDays(rows: readonly RawBar[]): {
  sessions: Map<string, MinuteBar[]>;
  premarket: Map<string, number>;
} {
  const sessions = new Map<string, MinuteBar[]>();
  const premarket = new Map<string, number>();
  for (const r of rows) {
    const { date, minute } = newYork(r.start * 1000);
    if (minute >= 240 && minute < 570) {
      premarket.set(date, (premarket.get(date) ?? 0) + r.volume);
      continue;
    }
    const m = minute - 570;
    if (m < 0 || m >= 390) continue;
    let list = sessions.get(date);
    if (!list) sessions.set(date, (list = []));
    list.push({ m, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume });
  }
  return { sessions, premarket };
}

/** Alpaca's market and trading data for one run, read once each. */
export class AlpacaBacktestData implements BacktestData {
  private readonly chains = new Map<string, Promise<ChainContract[]>>();
  private readonly days = new Map<string, MinuteBar[]>(); // contract|date
  private readonly reports = new Map<
    string,
    Promise<EarningsReport[] | null>
  >();
  constructor(
    private readonly stocks: Map<string, ReturnType<typeof splitDays>>,
    readonly lastSession: string,
    private readonly credentials: { key: string; secret: string },
    private readonly tradingUrl: string,
    private readonly fetcher: typeof fetch,
    private readonly quotes?: OptionQuoteStore,
    private readonly optionStore?: OptionBarStore,
  ) {}

  bars(symbol: string, date: string) {
    return this.stocks.get(symbol)?.sessions.get(date) ?? [];
  }

  premarket(symbol: string, date: string) {
    const stock = this.stocks.get(symbol);
    // A session without any bar in the data is unknown, not zero.
    if (!stock?.sessions.has(date)) return null;
    return stock.premarket.get(date) ?? 0;
  }

  private async get(url: URL): Promise<unknown> {
    // Workers reject fetch invoked with a foreign `this` ("Illegal invocation").
    const response = await this.fetcher.call(globalThis, url, {
      headers: {
        "APCA-API-KEY-ID": this.credentials.key,
        "APCA-API-SECRET-KEY": this.credentials.secret,
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(`Alpaca ${url.pathname} failed (${response.status})`);
    return response.json();
  }

  chain(symbol: string, right: "call" | "put", from: string, to: string) {
    const key = `${symbol}|${right}|${from}|${to}`;
    let list = this.chains.get(key);
    if (!list)
      this.chains.set(key, (list = this.readChain(symbol, right, from, to)));
    return list;
  }

  private async readChain(
    symbol: string,
    right: string,
    from: string,
    to: string,
  ) {
    const out: ChainContract[] = [];
    // Expired contracts are "inactive"; both are read for any past date.
    for (const status of ["active", "inactive"]) {
      let page: string | undefined;
      do {
        const url = new URL("/v2/options/contracts", this.tradingUrl);
        url.searchParams.set("underlying_symbols", symbol);
        url.searchParams.set("type", right);
        url.searchParams.set("status", status);
        url.searchParams.set("expiration_date_gte", from);
        url.searchParams.set("expiration_date_lte", to);
        url.searchParams.set("limit", "10000");
        if (page) url.searchParams.set("page_token", page);
        const body = (await this.get(url)) as {
          option_contracts?: {
            symbol: string;
            expiration_date: string;
            strike_price: string | number;
          }[];
          next_page_token?: string | null;
        };
        for (const c of body.option_contracts ?? [])
          out.push({
            symbol: c.symbol,
            expiry: c.expiration_date,
            strike: Number(c.strike_price),
          });
        page = body.next_page_token ?? undefined;
      } while (page);
    }
    return out;
  }

  /** One-minute bars of contracts over [from, to], by contract and date. */
  private async optionBars(contracts: string[], from: string, to: string) {
    const out = new Map<string, Map<string, MinuteBar[]>>();
    for (let i = 0; i < contracts.length; i += 100) {
      const part = contracts.slice(i, i + 100);
      let page: string | undefined;
      do {
        const url = new URL("/v1beta1/options/bars", dataUrl);
        url.searchParams.set("symbols", part.join(","));
        url.searchParams.set("timeframe", "1Min");
        url.searchParams.set(
          "start",
          new Date(newYorkToUtc(from, 570)).toISOString(),
        );
        url.searchParams.set(
          "end",
          new Date(newYorkToUtc(to, 960)).toISOString(),
        );
        url.searchParams.set("limit", "10000");
        if (page) url.searchParams.set("page_token", page);
        const body = (await this.get(url)) as {
          bars?: Record<
            string,
            | {
                t: string;
                o: number;
                h: number;
                l: number;
                c: number;
                v: number;
              }[]
            | null
          >;
          next_page_token?: string | null;
        };
        for (const [symbol, rows] of Object.entries(body.bars ?? {}))
          for (const r of rows ?? []) {
            const { date, minute } = newYork(Date.parse(r.t));
            const m = minute - 570;
            if (m < 0 || m >= 390) continue;
            let byDate = out.get(symbol);
            if (!byDate) out.set(symbol, (byDate = new Map()));
            let list = byDate.get(date);
            if (!list) byDate.set(date, (list = []));
            list.push({ m, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
          }
        page = body.next_page_token ?? undefined;
      } while (page);
    }
    return out;
  }

  async optionDay(contracts: string[], date: string) {
    let need = contracts.filter((c) => !this.days.has(`${c}|${date}`));
    // The stored days first (option-bars.ts); a failed read only means fetching.
    if (need.length && this.optionStore) {
      const stored = await this.optionStore
        .get(need, date)
        .catch(() => new Map<string, MinuteBar[]>());
      for (const [c, bars] of stored) this.days.set(`${c}|${date}`, bars);
      need = need.filter((c) => !stored.has(c));
    }
    if (need.length) {
      const got = await this.optionBars(need, date, date);
      const fetched = new Map(
        need.map((c) => [c, got.get(c)?.get(date) ?? []] as const),
      );
      for (const [c, bars] of fetched) this.days.set(`${c}|${date}`, bars);
      await this.keep(
        [...fetched].map(([contract, bars]) => ({ contract, date, bars })),
      );
    }
    return new Map(contracts.map((c) => [c, this.days.get(`${c}|${date}`)!]));
  }

  async optionRange(contract: string, from: string, to: string) {
    const got =
      (await this.optionBars([contract], from, to)).get(contract) ??
      new Map<string, MinuteBar[]>();
    for (const m of got.values()) m.sort((a, b) => a.m - b.m);
    await this.keep([...got].map(([date, bars]) => ({ contract, date, bars })));
    return got;
  }

  /** Stores fetched days of finished sessions, one batch; a failed write is not an error. */
  private async keep(
    days: { contract: string; date: string; bars: MinuteBar[] }[],
  ) {
    const finished = days.filter((d) => d.date <= this.lastSession);
    if (!this.optionStore || !finished.length) return;
    await this.optionStore.put(finished).catch(() => {});
  }

  async optionQuotes(
    contract: string,
    from: string,
    to: string,
  ): Promise<Map<string, QuoteMinute[]>> {
    return this.quotes ? this.quotes.get(contract, from, to) : new Map();
  }

  earnings(date: string) {
    let reports = this.reports.get(date);
    if (!reports)
      this.reports.set(
        date,
        (reports = nasdaqEarnings(date, this.fetcher).catch(() => null)),
      );
    return reports;
  }
}

export async function handleBotBacktest(
  body: unknown,
  credentials: Credentials,
  tradingUrl: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  cache?: BarCache,
  quotes?: OptionQuoteStore,
  optionStore?: OptionBarStore,
): Promise<{ status: number; body: BotBacktestResponse | { error: string } }> {
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
  const window = dataWindow(
    dates,
    backtestCalendar,
    lastSession,
    settings.maxNights,
  );
  // Midnight to midnight New York, so the pre-market is in the cached days too.
  const start = new Date(newYorkToUtc(window.from, 0)).toISOString();
  const end = new Date(
    newYorkToUtc(nextSessions(window.to, 1)[0]!, 0),
  ).toISOString();
  try {
    const stocks = new Map<string, ReturnType<typeof splitDays>>();
    for (const s of [symbol, "SPY"])
      stocks.set(s, splitDays(await history(s, start, end)));
    const data = new AlpacaBacktestData(
      stocks,
      lastSession,
      { key: credentials.key, secret: credentials.secret },
      tradingUrl,
      fetcher,
      quotes,
      optionStore,
    );
    const run = await runStock(
      symbol,
      dates,
      settings,
      data,
      backtestCalendar,
      { fillPct },
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
