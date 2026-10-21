import { DatabaseSync } from "node:sqlite";

// The bot's records (docs/tasks/backend-indi-bot.md), in the trading
// service's database: every signal and what came of it, and every position
// the bot opened, with each sale and why. A restart resumes from here, and the
// bot only ever sells what these rows say it holds.

export interface BotSignal {
  day: string;
  symbol: string;
  right: "C" | "P";
  minute: number;
  t: number;
  rvol: number;
  // bought, would-buy (dry run), or why not: no_expiry, too_cheap, thin, held,
  // refused, error, off
  outcome: string;
  detail: string;
  at: number;
}

export interface BotSale {
  at: number;
  qty: number;
  reason: string;
  jobId: string | null; // null in a dry run
  settled?: boolean; // the sale's job has ended and `qty` is what sold
}

export type BotStatus = "buying" | "open" | "closed";

export interface BotPosition {
  id: string;
  day: string; // the entry day
  symbol: string; // the stock
  contract: string;
  right: "C" | "P";
  qty: number; // contracts the bot holds now
  bought: number; // contracts the entry filled
  cost: number; // average price paid
  entryMinute: number;
  entryStock: number;
  nights: number;
  checksDone: number[];
  morningDone: boolean;
  // The last day the 15:50 decision was taken, so it is taken once a day.
  decidedOn: string | null;
  status: BotStatus;
  jobId: string | null;
  dry: boolean;
  sales: BotSale[];
  openedAt: number;
  closedAt: number | null;
}

interface PositionRow {
  id: string;
  data: string;
}

export class BotStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS bot_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL,
        symbol TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE (day, symbol));
      CREATE TABLE IF NOT EXISTS bot_positions (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, day TEXT NOT NULL,
        data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_settings (
        name TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  close() {
    this.db.close();
  }

  /** One signal per stock per day; false when the day already has one. */
  addSignal(s: BotSignal): boolean {
    const r = this.db
      .prepare(
        "INSERT OR IGNORE INTO bot_signals (day, symbol, data) VALUES (?, ?, ?)",
      )
      .run(s.day, s.symbol, JSON.stringify(s));
    return r.changes > 0;
  }

  updateSignal(day: string, symbol: string, outcome: string, detail: string) {
    const s = this.signal(day, symbol);
    if (!s) return;
    this.db
      .prepare("UPDATE bot_signals SET data = ? WHERE day = ? AND symbol = ?")
      .run(JSON.stringify({ ...s, outcome, detail }), day, symbol);
  }

  signal(day: string, symbol: string): BotSignal | undefined {
    const row = this.db
      .prepare("SELECT data FROM bot_signals WHERE day = ? AND symbol = ?")
      .get(day, symbol) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as BotSignal) : undefined;
  }

  signals(day: string): BotSignal[] {
    return (
      this.db
        .prepare("SELECT data FROM bot_signals WHERE day = ? ORDER BY id")
        .all(day) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as BotSignal);
  }

  savePosition(p: BotPosition) {
    this.db
      .prepare(
        "INSERT INTO bot_positions (id, status, day, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data",
      )
      .run(p.id, p.status, p.day, JSON.stringify(p));
  }

  position(id: string): BotPosition | undefined {
    const row = this.db
      .prepare("SELECT id, data FROM bot_positions WHERE id = ?")
      .get(id) as PositionRow | undefined;
    return row ? (JSON.parse(row.data) as BotPosition) : undefined;
  }

  /** Positions still held or still buying. */
  openPositions(): BotPosition[] {
    return (
      this.db
        .prepare(
          "SELECT id, data FROM bot_positions WHERE status != 'closed' ORDER BY day, id",
        )
        .all() as unknown as PositionRow[]
    ).map((r) => JSON.parse(r.data) as BotPosition);
  }

  /** Positions opened or closed on or after `since` (a date). */
  recentPositions(since: string): BotPosition[] {
    return (
      this.db
        .prepare(
          "SELECT id, data FROM bot_positions WHERE day >= ? OR status != 'closed' ORDER BY day, id",
        )
        .all(since) as unknown as PositionRow[]
    ).map((r) => JSON.parse(r.data) as BotPosition);
  }

  setting(name: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM bot_settings WHERE name = ?")
      .get(name) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(name: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO bot_settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      )
      .run(name, value);
  }
}
