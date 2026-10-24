import { AlpacaFeed } from "./alpaca.js";
import { tickerPattern, type Credentials } from "./backtest.js";
import { coreClose, newYork, previousSessions } from "./calendar.js";
import { defaultSipDelayMinutes, sipDelayMs } from "./sip-delay.js";

// The minutes of one closed trade (docs/tasks/frontend-trade-story.md): the
// stock's close each minute of the sessions the trade spanned and, for an
// option, the contract's close each minute it traded. Regular hours only,
// one-minute bars from Alpaca, nothing cached. The page draws both and marks
// the entry and the exits on them.

export const sessionOpen = 570; // 09:30 New York, in minutes
/** The most sessions one chart shows: the first and the last ones of a long hold. */
export const maxSessions = 5;

export interface TradeChartSession {
  date: string; // New York session date
  minutes: number; // the session's length (390, fewer on an early close)
  stock: [number, number][]; // [minute since 09:30, close]
  option: [number, number][]; // the contract's bars, in the minutes it traded
}

export interface TradeChart {
  symbol: string; // the contract (OCC) or the stock
  underlying: string;
  option: boolean;
  sessions: TradeChartSession[]; // oldest first
  skipped: number; // sessions between the first and the rest left out
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
 * The sessions to draw for a trade held from `from` to `to`: all of them up
 * to five; a longer hold shows its first session and the last four, with the
 * number left out.
 */
export function chartSessions(
  from: string,
  to: string,
): { dates: string[]; skipped: number } {
  const last = [...previousSessions(to, maxSessions - 1), to];
  const shown = last.filter((d) => d >= from);
  if (shown.length < maxSessions || shown[0] === from)
    return { dates: shown, skipped: 0 };
  const between = previousSessions(shown[1]!, 400).filter((d) => d > from);
  return { dates: [from, ...shown.slice(1)], skipped: between.length };
}

const nextDay = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

interface OptionBar {
  t: string;
  c: number;
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

/** Each session's [minute, close] pairs from bars stamped in ms, regular hours only. */
function byMinute(
  bars: { at: number; close: number }[],
  dates: string[],
): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>(dates.map((d) => [d, []]));
  for (const b of bars) {
    const ny = newYork(b.at);
    const day = out.get(ny.date);
    if (!day) continue;
    const close = coreClose(ny.date)!;
    if (ny.minute < sessionOpen || ny.minute >= close) continue;
    day.push([ny.minute - sessionOpen, b.close]);
  }
  for (const day of out.values()) day.sort((a, b) => a[0] - b[0]);
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
      body: { error: "Give the first and last US trading day of the trade" },
    };
  const { dates, skipped } = chartSessions(from, to);
  const delayMinutes = credentials.sipDelayMinutes ?? defaultSipDelayMinutes;
  const until = now - sipDelayMs(delayMinutes);
  const end = Math.min(Date.parse(`${nextDay(to)}T06:00:00Z`), until);
  const startIso = `${dates[0]}T00:00:00Z`;
  if (Date.parse(`${to}T00:00:00Z`) >= until)
    return { status: 400, body: { error: "That day has no data yet" } };
  const endIso = new Date(end).toISOString();
  const feed = new AlpacaFeed(
    credentials.key,
    credentials.secret,
    "sip",
    () => {},
    fetcher,
  );
  try {
    const [stockRows, optionRows] = await Promise.all([
      feed.history(underlying, startIso, endIso, "1Min", "split"),
      option
        ? optionHistory(symbol, startIso, endIso, credentials, fetcher)
        : Promise.resolve([]),
    ]);
    const stock = byMinute(
      stockRows.map((r) => ({ at: r.start * 1000, close: r.close })),
      dates,
    );
    const contract = byMinute(
      optionRows.map((r) => ({ at: Date.parse(r.t), close: r.c })),
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
          stock: stock.get(date)!,
          option: contract.get(date)!,
        })),
        skipped,
        at: now,
      },
    };
  } catch (error) {
    return { status: 502, body: { error: (error as Error).message } };
  }
}
