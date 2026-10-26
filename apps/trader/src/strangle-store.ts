import { DatabaseSync } from "node:sqlite";
import type { OptionBook } from "./option-book.js";

// The alert leg bot's records (docs/tasks/backend-strangle-bot.md), in the
// trading service's database next to the Indi bot's, in tables of its own:
// every alert it acted on and what came of it, every trade with its leg, each order
// and why, its settings and its activity feed.

export type StrangleEventKind = "info" | "signal" | "skip" | "order" | "error";

export interface StrangleEvent {
  at: number;
  kind: StrangleEventKind;
  text: string;
}

export interface StrangleSignal {
  day: string;
  symbol: string;
  minute: number;
  side: "up" | "down";
  // traded, would-trade (dry run), or why not
  outcome: string;
  detail: string;
  at: number;
  // The leg picked and its bid / ask at the pick (also for a too-cheap one);
  // missing when none was picked, and on signals before 2026-10-25.
  book?: OptionBook & { contract: string };
}

export interface StrangleOrder {
  at: number;
  side: "buy" | "sell";
  qty: number; // asked; the filled count once settled
  reason: string;
  jobId: string | null; // null in a dry run
  settled: boolean;
  price?: number; // the fill (the mid in a dry run)
  book?: OptionBook; // bid / ask when the order was decided (missing before 2026-10-25)
}

export interface StrangleLeg {
  contract: string;
  strike: number;
  qty: number; // contracts held now
  bought: number; // contracts bought in all (entry and the recycled buy)
  cost: number; // average price paid
  orders: StrangleOrder[];
}

// watching: the alert came, waiting for the side; buying: the leg's buy is
// working; open: held; closing: the sale is working; closed.
export type StranglePhase =
  "watching" | "buying" | "open" | "closing" | "closed";

export interface StrangleTrade {
  id: string;
  day: string;
  symbol: string;
  alertMinute: number;
  alertSide: "up" | "down";
  unit: number; // the stock's typical 30-minute move, a fraction of its price
  stockRef: number; // the stock when the alert was read; the side is measured from here
  expiry?: string; // the leg's expiry: the day itself, or the next session (1DTE); absent on older trades = the day
  side: "C" | "P" | null;
  sideMinute: number | null;
  best: number | null; // the stock's best since the buy, the side's way
  leg: StrangleLeg | null;
  phase: StranglePhase;
  closeReason: string | null;
  dry: boolean;
  openedAt: number;
  closedAt: number | null;
}

export class StrangleStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS strangle_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL,
        symbol TEXT NOT NULL, data TEXT NOT NULL, UNIQUE (day, symbol));
      CREATE TABLE IF NOT EXISTS strangle_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL,
        symbol TEXT NOT NULL, minute INTEGER NOT NULL, data TEXT NOT NULL,
        UNIQUE (day, symbol, minute));
      CREATE TABLE IF NOT EXISTS strangle_trades (
        id TEXT PRIMARY KEY, phase TEXT NOT NULL, day TEXT NOT NULL,
        data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS strangle_settings (
        name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS strangle_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        kind TEXT NOT NULL, text TEXT NOT NULL);
    `);
    // Since re-entry (2026-10-26) a stock can have several alerts a day:
    // strangle_alerts replaces strangle_signals (one a day), copied once.
    const copied = this.db
      .prepare("SELECT COUNT(*) AS n FROM strangle_alerts")
      .get() as { n: number };
    if (copied.n === 0)
      this.db
        .exec(`INSERT OR IGNORE INTO strangle_alerts (day, symbol, minute, data)
        SELECT day, symbol, json_extract(data, '$.minute'), data FROM strangle_signals ORDER BY id`);
  }

  close() {
    this.db.close();
  }

  addEvent(at: number, kind: StrangleEventKind, text: string) {
    this.db
      .prepare("INSERT INTO strangle_events (at, kind, text) VALUES (?, ?, ?)")
      .run(at, kind, text);
    this.db
      .prepare(
        "DELETE FROM strangle_events WHERE id <= (SELECT MAX(id) FROM strangle_events) - 2000",
      )
      .run();
  }

  events(limit: number): StrangleEvent[] {
    return this.db
      .prepare(
        "SELECT at, kind, text FROM strangle_events ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as unknown as StrangleEvent[];
  }

  /** One signal per stock per alert minute; false when that minute already has one. */
  addSignal(s: StrangleSignal): boolean {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO strangle_alerts (day, symbol, minute, data) VALUES (?, ?, ?, ?)",
        )
        .run(s.day, s.symbol, s.minute, JSON.stringify(s)).changes > 0
    );
  }

  /** The stock's latest signal of the day: the one its current trade came from. */
  private latestId(day: string, symbol: string): number | undefined {
    const row = this.db
      .prepare(
        "SELECT MAX(id) AS id FROM strangle_alerts WHERE day = ? AND symbol = ?",
      )
      .get(day, symbol) as { id: number | null } | undefined;
    return row?.id ?? undefined;
  }

  updateSignal(day: string, symbol: string, outcome: string, detail: string) {
    const s = this.signal(day, symbol);
    const id = this.latestId(day, symbol);
    if (!s || id === undefined) return;
    this.db
      .prepare("UPDATE strangle_alerts SET data = ? WHERE id = ?")
      .run(JSON.stringify({ ...s, outcome, detail }), id);
  }

  /** The picked leg's book on the day's signal of `symbol`. */
  setSignalBook(
    day: string,
    symbol: string,
    book: OptionBook & { contract: string },
  ) {
    const s = this.signal(day, symbol);
    const id = this.latestId(day, symbol);
    if (!s || id === undefined) return;
    this.db
      .prepare("UPDATE strangle_alerts SET data = ? WHERE id = ?")
      .run(JSON.stringify({ ...s, book }), id);
  }

  /** The stock's latest signal of the day. */
  signal(day: string, symbol: string): StrangleSignal | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM strangle_alerts WHERE day = ? AND symbol = ? ORDER BY id DESC LIMIT 1",
      )
      .get(day, symbol) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as StrangleSignal) : undefined;
  }

  signals(day: string): StrangleSignal[] {
    return (
      this.db
        .prepare("SELECT data FROM strangle_alerts WHERE day = ? ORDER BY id")
        .all(day) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as StrangleSignal);
  }

  saveTrade(t: StrangleTrade) {
    this.db
      .prepare(
        "INSERT INTO strangle_trades (id, phase, day, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET phase = excluded.phase, data = excluded.data",
      )
      .run(t.id, t.phase, t.day, JSON.stringify(t));
  }

  openTrades(): StrangleTrade[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM strangle_trades WHERE phase != 'closed' ORDER BY day, id",
        )
        .all() as { data: string }[]
    ).map((r) => JSON.parse(r.data) as StrangleTrade);
  }

  /** Trades of `since` (a date) and later, newest first. */
  recentTrades(since: string): StrangleTrade[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM strangle_trades WHERE day >= ? ORDER BY day DESC, rowid DESC",
        )
        .all(since) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as StrangleTrade);
  }

  setting(name: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM strangle_settings WHERE name = ?")
      .get(name) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(name: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO strangle_settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      )
      .run(name, value);
  }
}

/** Dollars paid and got back for a trade so far (every settled fill). */
export function tradeCash(t: StrangleTrade): { paid: number; got: number } {
  let paid = 0;
  let got = 0;
  for (const o of t.leg?.orders ?? []) {
    if (!o.settled || o.price === undefined) continue;
    if (o.side === "buy") paid += o.qty * o.price * 100;
    else got += o.qty * o.price * 100;
  }
  return { paid, got };
}
