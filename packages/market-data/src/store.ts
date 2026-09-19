import { DatabaseSync } from "node:sqlite";
import type { Evaluation } from "../../alerts/src/relative-volume.js";
import type { PriceBar } from "./bars.js";

export class MarketStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS bars (ticker TEXT, end TEXT, date TEXT, payload TEXT NOT NULL, PRIMARY KEY(ticker,end));
      CREATE TABLE IF NOT EXISTS alerts (ticker TEXT, end TEXT, payload TEXT NOT NULL, PRIMARY KEY(ticker,end));`);
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
  alert(result: Evaluation) {
    this.db
      .prepare("INSERT OR IGNORE INTO alerts VALUES (?,?,?)")
      .run(result.ticker, result.end, JSON.stringify(result));
  }
  alerts(): Evaluation[] {
    return this.db
      .prepare("SELECT payload FROM alerts ORDER BY end DESC LIMIT 100")
      .all()
      .map((r) => JSON.parse(String(r.payload)) as Evaluation);
  }
  prune(before: string) {
    this.db.prepare("DELETE FROM bars WHERE date<?").run(before);
  }
  close() {
    this.db.close();
  }
}
