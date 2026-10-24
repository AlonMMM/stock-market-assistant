import { AlpacaFeed } from "./alpaca.js";
import { tickerPattern, type Credentials } from "./backtest.js";
import { coreClose, newYork, previousSessions } from "./calendar.js";
import { defaultSipDelayMinutes, sipDelayMs } from "./sip-delay.js";
import {
  cState,
  priorFrom,
  type MinuteBar,
} from "../../trading/src/bot/signal.js";

// The minutes of the days around one closed trade (docs/tasks/frontend-trade-story.md):
// the stock's one-minute bars, SPY's closes, the bot's strength against SPY
// minute by minute (the t-stat and the volume ratio the signal reads, from the
// 20 sessions before each day, as the bot computes them) and, for an option,
// the contract's bars in the minutes it traded. Regular hours only, from
// Alpaca, nothing cached. The page draws them on a chart that zooms and
// scrolls, and asks for more days as the viewer drags.

export const sessionOpen = 570; // 09:30 New York, in minutes
/** The most sessions one answer carries; the page asks again for more. */
export const maxSessions = 7;
/** The sessions before a day the signal's numbers are measured against. */
export const priorDays = 20;

/** [minute since 09:30, open, high, low, close, volume] */
export type ChartBar = [number, number, number, number, number, number];

export interface TradeChartSession {
  date: string; // New York session date
  minutes: number; // the session's length (390, fewer on an early close)
  stock: ChartBar[];
  spy: [number, number][]; // [minute, close]
  // [minute, t, volume ratio]: the strength against SPY as the bot reads it
  // at that minute; empty when the prior sessions were not enough.
  strength: [number, number, number][];
  option: ChartBar[]; // the contract's bars, in the minutes it traded
}

export interface TradeChart {
  symbol: string; // the contract (OCC) or the stock
  underlying: string;
  option: boolean;
  sessions: TradeChartSession[]; // oldest first, consecutive
  skipped: number; // sessions asked for before the first one carried
  at: number;
}

const occ = /^([A-Z]{1,6})\d{6}[CP]\d{8}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const optionsUrl = "https://data.alpaca.markets/v1beta1/options/bars";

const isSession = (date: string): boolean => {
  try {
    return coreClose(date) !== null;
  } catch {
    return false;
  }
};

/**
 * The sessions from `from` to `to`, at most `maxSessions`: a longer span
 * carries the last ones and says how many before them were left out.
 */
export function chartSessions(
  from: string,
  to: string,
): { dates: string[]; skipped: number } {
  const dates = [...previousSessions(to, maxSessions - 1), to].filter(
    (d) => d >= from,
  );
  if (dates.length < maxSessions || dates[0] === from)
    return { dates, skipped: 0 };
  const before = previousSessions(dates[0]!, 400).filter((d) => d >= from);
  return { dates, skipped: before.length };
}

const nextDay = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

interface OptionBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

async function optionHistory(
  contract: string,
  start: string,
  end: string,
  credentials: Credentials,
  fetcher: typeof fetch,
): Promise<OptionBar[]> {
  const rows: OptionBar[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const url = new URL(optionsUrl);
    url.searchParams.set("symbols", contract);
    url.searchParams.set("timeframe", "1Min");
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);
    url.searchParams.set("limit", "10000");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const response = await fetcher(url, {
      headers: {
        "APCA-API-KEY-ID": credentials.key!,
        "APCA-API-SECRET-KEY": credentials.secret!,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(`Alpaca option bars failed (${response.status})`);
    const body = (await response.json()) as {
      bars?: Record<string, OptionBar[] | null>;
      next_page_token?: string | null;
    };
    rows.push(...(body.bars?.[contract] ?? []));
    if (!body.next_page_token) break;
    pageToken = body.next_page_token;
  }
  return rows;
}

interface Bar {
  at: number; // ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Each session's bars by session minute, regular hours only. */
function bySession(
  bars: Bar[],
  dates: Iterable<string>,
): Map<string, MinuteBar[]> {
  const out = new Map<string, MinuteBar[]>();
  for (const d of dates) out.set(d, []);
  for (const b of bars) {
    const ny = newYork(b.at);
    const day = out.get(ny.date);
    if (!day) continue;
    const close = coreClose(ny.date)!;
    if (ny.minute < sessionOpen || ny.minute >= close) continue;
    day.push({
      m: ny.minute - sessionOpen,
      o: b.o,
      h: b.h,
      l: b.l,
      c: b.c,
      v: b.v,
    });
  }
  for (const day of out.values()) day.sort((a, b) => a.m - b.m);
  return out;
}

const tuple = (b: MinuteBar): ChartBar => [b.m, b.o, b.h, b.l, b.c, b.v];

/**
 * The strength against SPY at each minute of `date`, as the bot's signal
 * reads it from the 20 sessions before: empty when they are not enough.
 */
export function strengthOf(
  date: string,
  stock: Map<string, MinuteBar[]>,
  spy: Map<string, MinuteBar[]>,
): [number, number, number][] {
  const prior = priorFrom(
    previousSessions(date, priorDays).map((d) => ({
      stock: stock.get(d) ?? [],
      spy: spy.get(d) ?? [],
    })),
  );
  const day = stock.get(date) ?? [];
  const spyDay = spy.get(date) ?? [];
  const minutes = coreClose(date)! - sessionOpen;
  const out: [number, number, number][] = [];
  for (let m = 1; m < minutes; m++) {
    const state = cState(day, spyDay, prior, m);
    if (state && Number.isFinite(state.t))
      out.push([m, Number(state.t.toFixed(2)), Number(state.rvol.toFixed(2))]);
  }
  return out;
}

/** `GET /api/trade-chart?symbol=RKLB251003C00080000&from=2026-09-30&to=2026-09-30`. */
export async function handleTradeChart(
  query: { symbol?: unknown; from?: unknown; to?: unknown },
  credentials: Credentials,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ status: number; body: TradeChart | { error: string } }> {
  if (!credentials.key || !credentials.secret)
    return {
      status: 503,
      body: { error: "Alpaca credentials are not configured on the server" },
    };
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const symbol = text(query.symbol).toUpperCase();
  const from = text(query.from);
  const to = text(query.to);
  const option = occ.exec(symbol);
  const underlying = option ? option[1]! : symbol;
  if (!option && !tickerPattern.test(symbol))
    return { status: 400, body: { error: "Give a contract or a stock" } };
  if (
    !datePattern.test(from) ||
    !datePattern.test(to) ||
    !isSession(from) ||
    !isSession(to) ||
    to < from
  )
    return {
      status: 400,
      body: { error: "Give the first and last US trading day to draw" },
    };
  const { dates, skipped } = chartSessions(from, to);
  const delayMinutes = credentials.sipDelayMinutes ?? defaultSipDelayMinutes;
  const until = now - sipDelayMs(delayMinutes);
  const end = Math.min(Date.parse(`${nextDay(to)}T06:00:00Z`), until);
  if (Date.parse(`${to}T00:00:00Z`) >= until)
    return { status: 400, body: { error: "That day has no data yet" } };
  // The stock and SPY from the 20 sessions before the first day, for the
  // strength; the contract from the first day.
  const prior = previousSessions(dates[0]!, priorDays);
  const priorIso = `${prior[0]}T00:00:00Z`;
  const startIso = `${dates[0]}T00:00:00Z`;
  const endIso = new Date(end).toISOString();
  const feed = new AlpacaFeed(
    credentials.key,
    credentials.secret,
    "sip",
    () => {},
    fetcher,
  );
  try {
    const [stockRows, spyRows, optionRows] = await Promise.all([
      feed.history(underlying, priorIso, endIso, "1Min", "split"),
      feed.history("SPY", priorIso, endIso, "1Min", "split"),
      option
        ? optionHistory(symbol, startIso, endIso, credentials, fetcher)
        : Promise.resolve([]),
    ]);
    const all = [...prior, ...dates];
    const raw = (r: (typeof stockRows)[number]): Bar => ({
      at: r.start * 1000,
      o: r.open,
      h: r.high,
      l: r.low,
      c: r.close,
      v: r.volume,
    });
    const stock = bySession(stockRows.map(raw), all);
    const spy = bySession(spyRows.map(raw), all);
    const contract = bySession(
      optionRows.map((r) => ({
        at: Date.parse(r.t),
        o: r.o,
        h: r.h,
        l: r.l,
        c: r.c,
        v: r.v,
      })),
      dates,
    );
    return {
      status: 200,
      body: {
        symbol,
        underlying,
        option: option !== null,
        sessions: dates.map((date) => ({
          date,
          minutes: coreClose(date)! - sessionOpen,
          stock: stock.get(date)!.map(tuple),
          spy: spy.get(date)!.map((b) => [b.m, b.c]),
          strength: strengthOf(date, stock, spy),
          option: contract.get(date)!.map(tuple),
        })),
        skipped,
        at: now,
      },
    };
  } catch (error) {
    return { status: 502, body: { error: (error as Error).message } };
  }
}
