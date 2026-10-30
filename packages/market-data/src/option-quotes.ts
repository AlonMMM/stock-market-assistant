import type { D1Like } from "./bar-cache.js";
import type { QuoteMinute } from "../../trading/src/bot/backtest.js";

export type { QuoteMinute };

// Real option quotes for the backtest (the user, 2026-10-31: "anytime we download
// something we will upload to the db"). The server never fetches them: the Mac
// writes them with `wrangler d1 execute` (scripts/research/indi_bt/quotes_upload.py
// in the research checkout) from two sources, and the backtest only reads:
// - "databento": cbbo-1m, every minute of a contract's day;
// - "live": the books the bots saved at their signals, buys and sales; on a
//   minute with both, the live one wins (it is what the paper account saw).
// One row per contract, day and source; `quotes` is the compact JSON
// [[minute, bid, ask], ...], gzipped and base64'd with a "gz:" prefix like the
// bar cache, or plain JSON. A minute is the session minute (09:30 New York = 0)
// and its book is the one as that minute closed.

export interface OptionQuoteStore {
  /** One contract's quotes on each date that has any, by date, oldest minute first. */
  get(
    contract: string,
    from: string,
    to: string,
  ): Promise<Map<string, QuoteMinute[]>>;
}

export const quotesTable =
  "CREATE TABLE IF NOT EXISTS option_quotes (contract TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL, quotes TEXT NOT NULL, stored_at INTEGER NOT NULL, PRIMARY KEY (contract, date, source))";

async function unpackQuotes(text: string): Promise<[number, number, number][]> {
  if (!text.startsWith("gz:")) return JSON.parse(text);
  const bytes = Uint8Array.from(atob(text.slice(3)), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

/** The sources of one day merged: Databento's minutes, the live books over them. */
export function mergeSources(
  rows: { source: string; quotes: [number, number, number][] }[],
): QuoteMinute[] {
  const byMinute = new Map<number, QuoteMinute>();
  const order = (s: string) => (s === "live" ? 1 : 0);
  for (const r of [...rows].sort((a, b) => order(a.source) - order(b.source)))
    for (const [m, bid, ask] of r.quotes)
      if (ask > 0 && bid >= 0 && bid <= ask) byMinute.set(m, { m, bid, ask });
  return [...byMinute.values()].sort((a, b) => a.m - b.m);
}

export class D1OptionQuotes implements OptionQuoteStore {
  private ready?: Promise<unknown>;
  constructor(private db: D1Like) {}
  private init() {
    return (this.ready ??= this.db.prepare(quotesTable).run());
  }
  async get(contract: string, from: string, to: string) {
    await this.init();
    const { results } = await this.db
      .prepare(
        "SELECT date, source, quotes FROM option_quotes WHERE contract = ? AND date BETWEEN ? AND ?",
      )
      .bind(contract, from, to)
      .all<{ date: string; source: string; quotes: string }>();
    const byDate = new Map<
      string,
      { source: string; quotes: [number, number, number][] }[]
    >();
    for (const row of results) {
      let list = byDate.get(row.date);
      if (!list) byDate.set(row.date, (list = []));
      list.push({ source: row.source, quotes: await unpackQuotes(row.quotes) });
    }
    const out = new Map<string, QuoteMinute[]>();
    for (const [date, rows] of byDate) {
      const day = mergeSources(rows);
      if (day.length) out.set(date, day);
    }
    return out;
  }
}
