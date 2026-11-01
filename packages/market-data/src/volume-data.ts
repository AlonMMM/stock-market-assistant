import type { D1Like, D1Statement } from "./bar-cache.js";
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
// The days the scheduled step copied from the trader (volume-daily.ts).
export const volumeDaysTable =
  "CREATE TABLE IF NOT EXISTS volume_days (date TEXT PRIMARY KEY, alerts INTEGER NOT NULL, windows INTEGER NOT NULL, synced_at INTEGER NOT NULL)";

// Statements a batch: each batch is one Worker subrequest.
const perBatch = 50;

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
  /** Stores fired 10-second alerts. */
  putAlerts(
    alerts: { symbol: string; kind: "shock" | "fast"; alert: ShockAlert }[],
  ): Promise<void>;
  /** Stores option windows ([second, bid, ask] rows). */
  putOptionWindows(
    windows: {
      contract: string;
      date: string;
      start: number;
      end: number;
      rows: [number, number, number][];
    }[],
  ): Promise<void>;
  /** Whether the scheduled step already copied a day from the trader. */
  daySynced(date: string): Promise<boolean>;
  markDay(date: string, alerts: number, windows: number): Promise<void>;
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
      this.db.prepare(volumeDaysTable),
    ]));
  }

  private async write(statements: D1Statement[]) {
    for (let i = 0; i < statements.length; i += perBatch)
      await this.db.batch(statements.slice(i, i + perBatch));
  }

  async putAlerts(
    alerts: { symbol: string; kind: "shock" | "fast"; alert: ShockAlert }[],
  ) {
    await this.init();
    await this.write(
      alerts.map(({ symbol, kind, alert: a }) =>
        this.db
          .prepare(
            "INSERT OR REPLACE INTO volume_alerts (symbol, date, kind, second, price, up) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(symbol, a.date, kind, a.second, a.price, a.up ? 1 : 0),
      ),
    );
  }

  async putOptionWindows(
    windows: {
      contract: string;
      date: string;
      start: number;
      end: number;
      rows: [number, number, number][];
    }[],
  ) {
    await this.init();
    const statements: D1Statement[] = [];
    for (const w of windows)
      statements.push(
        this.db
          .prepare(
            "INSERT OR REPLACE INTO option_seconds (contract, date, start, end, rows) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(w.contract, w.date, w.start, w.end, await packJson(w.rows)),
      );
    await this.write(statements);
  }

  async daySynced(date: string) {
    await this.init();
    const { results } = await this.db
      .prepare("SELECT date FROM volume_days WHERE date = ?")
      .bind(date)
      .all();
    return results.length > 0;
  }

  async markDay(date: string, alerts: number, windows: number) {
    await this.init();
    await this.db
      .prepare(
        "INSERT OR REPLACE INTO volume_days (date, alerts, windows, synced_at) VALUES (?, ?, ?, ?)",
      )
      .bind(date, alerts, windows, Date.now())
      .run();
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
    // Several stored windows can cover one range (the research's Databento
    // window, which starts at its alert's second, and one the backtest built
    // from Alpaca trades for an earlier alert): the one starting nearest
    // before the range, the alert's own when there is one, so every run reads
    // the same prices (USO 2026-10-08 read the earlier shock's, unordered).
    const { results } = await this.db
      .prepare(
        "SELECT rows FROM stock_seconds WHERE symbol = ? AND date = ? AND start <= ? AND end >= ? ORDER BY start DESC LIMIT 1",
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
