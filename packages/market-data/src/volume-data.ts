import type { D1Like } from "./bar-cache.js";
import type {
  SecondBook,
  ShockAlert,
} from "../../trading/src/strangle/backtest.js";

// The Volume bot's backtest data kept in D1 (the user, 2026-10-31: "lets open
// the volume for backtesting on the app"), next to the bars and the real
// quotes: the shock alerts, computed on the Mac from its 10-second bars with
// the live rule (scripts/volume-data-upload.ts), and the 1-second windows
// after alerts (a stock's last price each second; an option's book as each
// second ended): the research's Databento windows uploaded from the Mac, and
// the stock windows the backtest reads from Alpaca, kept so a rerun reads them
// back. Windows are stored as gzipped, base64'd JSON with a "gz:" prefix like
// the bar cache; a window covers session seconds [start, end] (09:30 New
// York = 0).

export const volumeAlertsTable =
  "CREATE TABLE IF NOT EXISTS volume_alerts (symbol TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, second INTEGER NOT NULL, price REAL NOT NULL, up INTEGER NOT NULL, PRIMARY KEY (symbol, date, kind, second))";
export const stockSecondsTable =
  "CREATE TABLE IF NOT EXISTS stock_seconds (symbol TEXT NOT NULL, date TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, rows TEXT NOT NULL, PRIMARY KEY (symbol, date, start))";
export const optionSecondsTable =
  "CREATE TABLE IF NOT EXISTS option_seconds (contract TEXT NOT NULL, date TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, rows TEXT NOT NULL, PRIMARY KEY (contract, date, start))";

export interface VolumeDataStore {
  /** A stock's shock alerts over [from, to]. */
  shocks(symbol: string, from: string, to: string): Promise<ShockAlert[]>;
  /** A stored stock window covering [from, to], as [second, price] rows; null when none does. */
  stock(
    symbol: string,
    date: string,
    from: number,
    to: number,
  ): Promise<[number, number][] | null>;
  putStock(
    symbol: string,
    date: string,
    from: number,
    to: number,
    rows: [number, number][],
  ): Promise<void>;
  /** A contract's stored 1-second books overlapping [from, to]; empty when none. */
  option(
    contract: string,
    date: string,
    from: number,
    to: number,
  ): Promise<SecondBook[]>;
}

export async function packJson(value: unknown): Promise<string> {
  const stream = new Blob([JSON.stringify(value)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `gz:${btoa(binary)}`;
}

export async function unpackJson<T>(text: string): Promise<T> {
  if (!text.startsWith("gz:")) return JSON.parse(text) as T;
  const bytes = Uint8Array.from(atob(text.slice(3)), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text()) as T;
}

export class D1VolumeData implements VolumeDataStore {
  private ready?: Promise<unknown>;
  constructor(private db: D1Like) {}
  private init() {
    return (this.ready ??= this.db.batch([
      this.db.prepare(volumeAlertsTable),
      this.db.prepare(stockSecondsTable),
      this.db.prepare(optionSecondsTable),
    ]));
  }

  async shocks(symbol: string, from: string, to: string) {
    await this.init();
    const { results } = await this.db
      .prepare(
        "SELECT date, second, price, up FROM volume_alerts WHERE symbol = ? AND kind = 'shock' AND date BETWEEN ? AND ? ORDER BY date, second",
      )
      .bind(symbol, from, to)
      .all<{ date: string; second: number; price: number; up: number }>();
    return results.map((r) => ({
      date: r.date,
      second: r.second,
      price: r.price,
      up: r.up === 1,
    }));
  }

  async stock(symbol: string, date: string, from: number, to: number) {
    await this.init();
    const { results } = await this.db
      .prepare(
        "SELECT rows FROM stock_seconds WHERE symbol = ? AND date = ? AND start <= ? AND end >= ? LIMIT 1",
      )
      .bind(symbol, date, from, to)
      .all<{ rows: string }>();
    const row = results[0];
    if (!row) return null;
    return (await unpackJson<[number, number][]>(row.rows)).filter(
      ([s]) => s >= from && s <= to,
    );
  }

  async putStock(
    symbol: string,
    date: string,
    from: number,
    to: number,
    rows: [number, number][],
  ) {
    await this.init();
    await this.db
      .prepare(
        "INSERT OR REPLACE INTO stock_seconds (symbol, date, start, end, rows) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(symbol, date, from, to, await packJson(rows))
      .run();
  }

  async option(contract: string, date: string, from: number, to: number) {
    await this.init();
    const { results } = await this.db
      .prepare(
        "SELECT rows FROM option_seconds WHERE contract = ? AND date = ? AND start <= ? AND end >= ?",
      )
      .bind(contract, date, to, from)
      .all<{ rows: string }>();
    const by = new Map<number, SecondBook>();
    for (const r of results)
      for (const [s, bid, ask] of await unpackJson<[number, number, number][]>(
        r.rows,
      ))
        by.set(s, { s, bid, ask });
    return [...by.values()].sort((a, b) => a.s - b.s);
  }
}
