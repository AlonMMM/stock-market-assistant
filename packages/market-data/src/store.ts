import { DatabaseSync } from "node:sqlite";
import type { AlertEvent } from "../../alerts/src/events.js";
import type { PriceBar } from "./bars.js";
import type { SpyStrength } from "./rs-score.js";
import type { DailyStore } from "./volume-baseline.js";

// A stored live alert (never synthetic), with its score vs SPY when known.
export type StoredAlert = Omit<AlertEvent, "synthetic">;

export interface StoredWatchlist {
  name: string;
  syncedAt: string;
  tickers: string[];
  benchmarks?: Record<string, string>;
}

export class MarketStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS bars (ticker TEXT, end TEXT, date TEXT, payload TEXT NOT NULL, PRIMARY KEY(ticker,end));
      CREATE TABLE IF NOT EXISTS alerts (ticker TEXT, end TEXT, payload TEXT NOT NULL, PRIMARY KEY(ticker,end));
      CREATE TABLE IF NOT EXISTS watchlist (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS spy_strength (date TEXT, ticker TEXT, payload TEXT NOT NULL, PRIMARY KEY(date,ticker));`);
  }
  put(bar: PriceBar) {
    this.db
      .prepare(
        "INSERT INTO bars VALUES (?,?,?,?) ON CONFLICT(ticker,end) DO UPDATE SET payload=excluded.payload",
      )
      .run(bar.ticker, bar.end, bar.date, JSON.stringify(bar));
  }
  bars(ticker: string, from: string): PriceBar[] {
    return this.db
      .prepare(
        "SELECT payload FROM bars WHERE ticker=? AND date>=? ORDER BY end",
      )
      .all(ticker, from)
      .map((r) => JSON.parse(String(r.payload)) as PriceBar);
  }
  // True when the alert is new; a repeated (ticker, end) is ignored.
  alert(result: StoredAlert): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO alerts VALUES (?,?,?)")
        .run(result.ticker, result.end, JSON.stringify(result)).changes > 0
    );
  }
  alerts(): StoredAlert[] {
    return this.db
      .prepare("SELECT payload FROM alerts ORDER BY end DESC LIMIT 100")
      .all()
      .map((r) => JSON.parse(String(r.payload)) as StoredAlert);
  }
  findAlert(ticker: string, end: string): StoredAlert | null {
    const row = this.db
      .prepare("SELECT payload FROM alerts WHERE ticker=? AND end=?")
      .get(ticker, end);
    return row ? (JSON.parse(String(row.payload)) as StoredAlert) : null;
  }
  watchlist(): StoredWatchlist | null {
    const row = this.db
      .prepare("SELECT payload FROM watchlist WHERE id=1")
      .get();
    return row ? (JSON.parse(String(row.payload)) as StoredWatchlist) : null;
  }
  setWatchlist(list: StoredWatchlist) {
    this.db
      .prepare(
        "INSERT INTO watchlist VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(JSON.stringify(list));
  }
  // β/σ vs SPY per US session date and symbol (docs/features/alert-vs-spy.md).
  readonly strengths: DailyStore<SpyStrength> = {
    get: async (date, tickers) => {
      const wanted = new Set(tickers);
      const result = new Map<string, SpyStrength>();
      for (const row of this.db
        .prepare("SELECT ticker, payload FROM spy_strength WHERE date=?")
        .all(date))
        if (wanted.has(String(row.ticker)))
          result.set(
            String(row.ticker),
            JSON.parse(String(row.payload)) as SpyStrength,
          );
      return result;
    },
    put: async (date, values) => {
      const insert = this.db.prepare(
        "INSERT INTO spy_strength VALUES (?,?,?) ON CONFLICT(date,ticker) DO UPDATE SET payload=excluded.payload",
      );
      for (const [ticker, value] of values)
        insert.run(date, ticker, JSON.stringify(value));
    },
  };
  prune(before: string) {
    this.db.prepare("DELETE FROM bars WHERE date<?").run(before);
    this.db.prepare("DELETE FROM spy_strength WHERE date<?").run(before);
  }
  close() {
    this.db.close();
  }
}
