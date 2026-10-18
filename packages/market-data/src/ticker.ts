import { AlpacaFeed } from "./alpaca.js";
import { tickerPattern, type Credentials } from "./backtest.js";
import type { RawBar } from "./bars.js";

// One stock's own page (user 2026-10-18: "open the ticker with extra data in
// its own page, like IBKR"): what it is, its price now, the past year in a
// few numbers next to SPY's, and its latest news. Everything comes from
// Alpaca; each part that fails is left out (null) and the rest is shown.

export interface TickerInfo {
  ticker: string;
  // Alpaca's asset record: the company's name and where it lists.
  asset: {
    name: string;
    exchange: string;
    tradable: boolean;
    shortable: boolean;
    optionable: boolean | null;
  } | null;
  quote: {
    last: number | null;
    bid: number | null;
    ask: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    volume: number | null;
    previousClose: number | null;
    vwap: number | null;
    at: number | null; // the last trade (ms)
  } | null;
  stats: TickerStats | null;
  news: {
    headline: string;
    source: string;
    url: string;
    at: number; // ms
    summary: string;
  }[];
}

export interface TickerStats {
  // The past 52 weeks of daily closes, highs and lows.
  yearHigh: number;
  yearLow: number;
  // Average shares a day over the last 30 sessions.
  avgVolume30: number;
  // % change over each period, the stock's and SPY's; null without the
  // history (a stock listed recently).
  returns: {
    period: "1W" | "1M" | "3M" | "6M" | "YTD" | "1Y";
    stock: number | null;
    spy: number | null;
  }[];
  // Daily closes for a one-year line, oldest first: [Unix seconds, close].
  closes: [number, number][];
}

const days = 86_400_000;
const periods: [TickerStats["returns"][number]["period"], number | "ytd"][] = [
  ["1W", 7],
  ["1M", 30],
  ["3M", 91],
  ["6M", 182],
  ["YTD", "ytd"],
  ["1Y", 365],
];

/** % change from the last close on or before `from` to the latest close. */
function change(bars: RawBar[], from: number): number | null {
  const last = bars.at(-1);
  let base: RawBar | undefined;
  for (const b of bars) {
    if (b.start * 1000 > from) break;
    base = b;
  }
  if (!last || !base || !(base.close > 0)) return null;
  return ((last.close - base.close) / base.close) * 100;
}

/** The year's numbers from daily bars, oldest first. */
export function tickerStats(
  bars: RawBar[],
  spy: RawBar[],
  now: number,
): TickerStats | null {
  const year = bars.filter((b) => b.start * 1000 >= now - 365 * days);
  if (year.length === 0) return null;
  const recent = year.slice(-30);
  const jan1 = Date.UTC(new Date(now).getUTCFullYear(), 0, 1) - 1;
  return {
    yearHigh: Math.max(...year.map((b) => b.high)),
    yearLow: Math.min(...year.map((b) => b.low)),
    avgVolume30: Math.round(
      recent.reduce((s, b) => s + b.volume, 0) / recent.length,
    ),
    returns: periods.map(([period, span]) => {
      const from = span === "ytd" ? jan1 : now - span * days;
      return { period, stock: change(bars, from), spy: change(spy, from) };
    }),
    closes: year.map((b) => [b.start, b.close]),
  };
}

interface Snapshot {
  latestTrade?: { p?: number; t?: string };
  latestQuote?: { bp?: number; ap?: number };
  dailyBar?: { o?: number; h?: number; l?: number; v?: number; vw?: number };
  prevDailyBar?: { c?: number };
}
interface Asset {
  name?: string;
  exchange?: string;
  tradable?: boolean;
  shortable?: boolean;
  attributes?: string[];
}
interface News {
  news?: {
    headline?: string;
    source?: string;
    url?: string;
    created_at?: string;
    summary?: string;
  }[];
}

const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * `GET /api/ticker?ticker=NVDA`. `tradingUrl` is the account's trading API
 * (paper or live), which holds the asset records.
 */
export async function handleTicker(
  query: { ticker?: unknown },
  credentials: Credentials,
  tradingUrl: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ status: number; body: TickerInfo | { error: string } }> {
  if (!credentials.key || !credentials.secret)
    return {
      status: 503,
      body: { error: "Alpaca credentials are not configured on the server" },
    };
  const ticker =
    typeof query.ticker === "string" ? query.ticker.toUpperCase() : "";
  if (!tickerPattern.test(ticker))
    return { status: 400, body: { error: "Give a US ticker" } };
  const headers = {
    "APCA-API-KEY-ID": credentials.key,
    "APCA-API-SECRET-KEY": credentials.secret,
  };
  const get = <T>(url: string) =>
    fetcher
      .call(globalThis, url, { headers, signal: AbortSignal.timeout(10000) })
      .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
      .catch(() => null);
  const feed = new AlpacaFeed(
    credentials.key,
    credentials.secret,
    "sip",
    () => {},
    fetcher,
  );
  // A year and a week of daily bars: the 1Y return needs a close before it.
  const start = new Date(now - 372 * days).toISOString();
  const end = new Date(now).toISOString();
  const daily = (symbol: string) =>
    feed.history(symbol, start, end, "1Day", "split").catch(() => null);
  const symbol = encodeURIComponent(ticker);
  const [snapshot, asset, news, bars, spy] = await Promise.all([
    get<Snapshot>(
      `https://data.alpaca.markets/v2/stocks/${symbol}/snapshot?feed=sip`,
    ),
    get<Asset>(`${tradingUrl}/v2/assets/${symbol}`),
    get<News>(
      `https://data.alpaca.markets/v1beta1/news?symbols=${symbol}&limit=8&sort=desc`,
    ),
    daily(ticker),
    ticker === "SPY" ? Promise.resolve(null) : daily("SPY"),
  ]);
  if (!snapshot && !bars && !asset)
    return { status: 502, body: { error: `No data for ${ticker}` } };
  const tradedAt = snapshot?.latestTrade?.t
    ? Date.parse(snapshot.latestTrade.t)
    : NaN;
  return {
    status: 200,
    body: {
      ticker,
      asset:
        asset && typeof asset.name === "string"
          ? {
              name: asset.name,
              exchange: asset.exchange ?? "",
              tradable: asset.tradable === true,
              shortable: asset.shortable === true,
              optionable: Array.isArray(asset.attributes)
                ? asset.attributes.includes("has_options")
                : null,
            }
          : null,
      quote: snapshot
        ? {
            last: num(snapshot.latestTrade?.p),
            bid: num(snapshot.latestQuote?.bp),
            ask: num(snapshot.latestQuote?.ap),
            open: num(snapshot.dailyBar?.o),
            high: num(snapshot.dailyBar?.h),
            low: num(snapshot.dailyBar?.l),
            volume: num(snapshot.dailyBar?.v),
            previousClose: num(snapshot.prevDailyBar?.c),
            vwap: num(snapshot.dailyBar?.vw),
            at: Number.isFinite(tradedAt) ? tradedAt : null,
          }
        : null,
      stats: bars
        ? tickerStats(bars, ticker === "SPY" ? bars : (spy ?? []), now)
        : null,
      news: (news?.news ?? [])
        .filter(
          (n) =>
            typeof n.headline === "string" &&
            typeof n.url === "string" &&
            /^https:\/\//.test(n.url),
        )
        .map((n) => ({
          headline: n.headline!,
          source: n.source ?? "",
          url: n.url!,
          at: n.created_at ? Date.parse(n.created_at) : 0,
          summary: n.summary ?? "",
        })),
    },
  };
}
