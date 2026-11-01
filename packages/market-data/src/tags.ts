import { nasdaqEarnings } from "../../trading/src/bot/nasdaq.js";
import type { EarningsReport } from "../../trading/src/bot/news.js";
import { tickerPattern, type Credentials } from "./backtest.js";
import { newYork, newYorkToUtc } from "./calendar.js";

// Stock tags (user 2026-11-01: "If the stock has earning next 24h / If stock
// had earning 24h / If stock has earning this week / Big news on the stock.
// Each should have a different color tag. Tag should be visible everywhere
// including watchlist").
//
// - earnings-soon: the report is due in the next 24 hours.
// - earnings-past: the report came out in the last 24 hours.
// - earnings-week: the report is later this Monday–Friday week (on a weekend,
//   the coming week). A stock gets one earnings tag, the most urgent, in that
//   order.
// - big-news: 3 or more Alpaca news headlines on the stock in the last 24
//   hours (user 2026-11-01, "many headlines").
//
// Earnings come from the public Nasdaq calendar (the bot's source), which
// gives a date and "before the open" / "after the close" / no time. The
// moment used for the 24-hour windows is 08:00 New York before the open,
// 16:00 after the close, and 12:00 when no time is given.

export type EarningsTiming = "pre" | "post" | "unknown";

export interface EarningsTag {
  kind: "earnings-soon" | "earnings-past" | "earnings-week";
  at: number; // ms, the estimated report moment
  date: string; // the New York date the calendar lists
  timing: EarningsTiming;
}
export type StockTag = EarningsTag | { kind: "big-news"; headlines: number };

export interface TagsResponse {
  stocks: Record<string, StockTag[]>;
  // A source that failed is named, so the page never shows its tags as absent.
  earnings: "ok" | "unavailable";
  news: "ok" | "unavailable";
  at: number;
}

export const bigNewsHeadlines = 3;
const hour = 3_600_000;
const day = 24 * hour;
const maxSymbols = 200;

const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + n * day)
    .toISOString()
    .slice(0, 10);
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 Sunday

/** The Friday that ends "this week" in New York: on a weekend, next week's. */
export function weekFriday(now: number): string {
  const today = newYork(now).date;
  const d = weekday(today);
  if (d === 6) return addDays(today, 6);
  if (d === 0) return addDays(today, 5);
  return addDays(today, 5 - d);
}

/** The calendar dates to read for `now`: yesterday through this week's Friday. */
export function tagDates(now: number): string[] {
  const today = newYork(now).date;
  const out: string[] = [];
  const last = weekFriday(now);
  const end = last > addDays(today, 1) ? last : addDays(today, 1);
  for (let d = addDays(today, -1); d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export function timingOf(time: string): EarningsTiming {
  if (time === "time-pre-market") return "pre";
  if (time === "time-after-hours") return "post";
  return "unknown";
}

/** The estimated report moment of a calendar row. */
export function reportMoment(report: EarningsReport): number {
  const timing = timingOf(report.time);
  const minute = timing === "pre" ? 480 : timing === "post" ? 960 : 720;
  return newYorkToUtc(report.date, minute);
}

/** The one earnings tag a stock's reports make at `now`, or null. Pure. */
export function earningsTag(
  reports: readonly EarningsReport[],
  now: number,
): EarningsTag | null {
  const friday = weekFriday(now);
  let best: EarningsTag | null = null;
  const rank = { "earnings-soon": 0, "earnings-past": 1, "earnings-week": 2 };
  for (const r of reports) {
    const at = reportMoment(r);
    const kind =
      at > now && at <= now + day
        ? "earnings-soon"
        : at <= now && at >= now - day
          ? "earnings-past"
          : at > now + day && r.date <= friday
            ? "earnings-week"
            : null;
    if (!kind) continue;
    if (
      !best ||
      rank[kind] < rank[best.kind] ||
      (rank[kind] === rank[best.kind] &&
        Math.abs(at - now) < Math.abs(best.at - now))
    )
      best = { kind, at, date: r.date, timing: timingOf(r.time) };
  }
  return best;
}

/** Each symbol's tags from the calendar rows and headline counts. Pure. */
export function stockTags(
  symbols: readonly string[],
  reports: readonly EarningsReport[],
  headlines: ReadonlyMap<string, number>,
  now: number,
): Record<string, StockTag[]> {
  const bySymbol = new Map<string, EarningsReport[]>();
  for (const r of reports) {
    const list = bySymbol.get(r.symbol) ?? [];
    list.push(r);
    bySymbol.set(r.symbol, list);
  }
  const out: Record<string, StockTag[]> = {};
  for (const s of symbols) {
    const tags: StockTag[] = [];
    const e = earningsTag(bySymbol.get(s) ?? [], now);
    if (e) tags.push(e);
    const n = headlines.get(s) ?? 0;
    if (n >= bigNewsHeadlines) tags.push({ kind: "big-news", headlines: n });
    out[s] = tags;
  }
  return out;
}

// The calendar is the same for every stock, so each date is kept for an hour
// (a past date for a day) in this process or Worker isolate.
const calendarCache = new Map<string, { at: number; rows: EarningsReport[] }>();
async function calendarRows(
  date: string,
  now: number,
  fetcher: typeof fetch,
): Promise<EarningsReport[]> {
  const hit = calendarCache.get(date);
  const ttl = date < newYork(now).date ? day : hour;
  if (hit && now - hit.at < ttl) return hit.rows;
  const rows = await nasdaqEarnings(date, fetcher);
  if (calendarCache.size > 60) calendarCache.clear();
  calendarCache.set(date, { at: now, rows });
  return rows;
}

// Headline counts are kept for 5 minutes per symbol.
const newsCache = new Map<string, { at: number; count: number }>();
const newsTtl = 5 * 60_000;

interface NewsPage {
  news?: { symbols?: unknown }[];
  next_page_token?: string | null;
}

async function headlineCounts(
  symbols: readonly string[],
  credentials: Credentials,
  now: number,
  fetcher: typeof fetch,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const missing = symbols.filter((s) => {
    const hit = newsCache.get(s);
    if (hit && now - hit.at < newsTtl) {
      counts.set(s, hit.count);
      return false;
    }
    return true;
  });
  const headers = {
    "APCA-API-KEY-ID": credentials.key ?? "",
    "APCA-API-SECRET-KEY": credentials.secret ?? "",
  };
  const start = new Date(now - day).toISOString();
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const wanted = new Set(chunk);
    const found = new Map(chunk.map((s) => [s, 0]));
    let token: string | null | undefined;
    // Up to 10 pages of 50 headlines: enough to pass 3 a stock for busy lists.
    for (let page = 0; page < 10; page++) {
      const url = new URL("https://data.alpaca.markets/v1beta1/news");
      url.searchParams.set("symbols", chunk.join(","));
      url.searchParams.set("start", start);
      url.searchParams.set("limit", "50");
      url.searchParams.set("sort", "desc");
      if (token) url.searchParams.set("page_token", token);
      const response = await fetcher.call(globalThis, url.toString(), {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok)
        throw new Error(`Alpaca news failed (${response.status})`);
      const body = (await response.json()) as NewsPage;
      for (const n of body.news ?? []) {
        if (!Array.isArray(n.symbols)) continue;
        for (const s of n.symbols)
          if (typeof s === "string" && wanted.has(s))
            found.set(s, (found.get(s) ?? 0) + 1);
      }
      token = body.next_page_token;
      if (!token) break;
    }
    for (const [s, count] of found) {
      counts.set(s, count);
      newsCache.set(s, { at: now, count });
    }
  }
  if (newsCache.size > 2000) newsCache.clear();
  return counts;
}

/** `GET /api/tags?symbols=NVDA,AAPL`: each stock's tags. */
export async function handleTags(
  query: { symbols?: unknown },
  credentials: Credentials,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ status: number; body: TagsResponse | { error: string } }> {
  const symbols = [
    ...new Set(
      (typeof query.symbols === "string" ? query.symbols : "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => tickerPattern.test(s)),
    ),
  ];
  if (symbols.length === 0)
    return { status: 400, body: { error: "Give symbols" } };
  if (symbols.length > maxSymbols)
    return { status: 400, body: { error: `At most ${maxSymbols} symbols` } };

  let earnings: TagsResponse["earnings"] = "ok";
  const reportsP = Promise.all(
    tagDates(now).map((d) => calendarRows(d, now, fetcher)),
  )
    .then((all) => all.flat())
    .catch(() => {
      earnings = "unavailable";
      return [] as EarningsReport[];
    });
  let news: TagsResponse["news"] = "ok";
  const countsP =
    credentials.key && credentials.secret
      ? headlineCounts(symbols, credentials, now, fetcher).catch(() => {
          news = "unavailable";
          return new Map<string, number>();
        })
      : ((news = "unavailable"), Promise.resolve(new Map<string, number>()));
  const [reports, counts] = await Promise.all([reportsP, countsP]);
  return {
    status: 200,
    body: {
      stocks: stockTags(symbols, reports, counts, now),
      earnings,
      news,
      at: now,
    },
  };
}
