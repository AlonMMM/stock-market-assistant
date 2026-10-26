import { DatabaseSync } from "node:sqlite";
import type { BreakWatch } from "../../../packages/trading/src/bot/levels.js";
import type { BotBroker } from "../../../packages/trading/src/bot/settings.js";
import type { OptionBook } from "./option-book.js";

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
  // The bot version in force (versions.ts); missing on signals before versions.
  version?: string;
  // The contract picked and its bid / ask at the pick (also for a too-cheap
  // one); missing when no contract was picked, and on signals before 2026-10-25.
  book?: OptionBook & { contract: string };
}

export interface BotSale {
  at: number;
  qty: number;
  reason: string;
  jobId: string | null; // null in a dry run
  settled?: boolean; // the sale's job has ended and `qty` is what sold
  price?: number; // average fill (the mid in a dry run), for the drawdown pause
  book?: OptionBook; // bid / ask when the sale was decided (missing before 2026-10-25)
}

export type BotStatus = "buying" | "open" | "closed";

// info: warm-up, lists, checks passed; signal; skip; order: buys and sales; error
export type BotEventKind = "info" | "signal" | "skip" | "order" | "error";

export interface BotEvent {
  at: number;
  kind: BotEventKind;
  text: string;
}

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
  // The level the stock is watched at on the entry day (levels.ts); missing
  // on positions opened before the failed-break sale.
  breakWatch?: BreakWatch | null;
  // The last day the 15:50 decision was taken, so it is taken once a day.
  decidedOn: string | null;
  // The bot version that entered it ("2.1", or "2.1*" with changed rules);
  // missing on positions opened before versions.
  version?: string;
  // The broker it was bought at; its sales go there too. Missing on positions
  // opened before the broker setting: those were bought at the start-up default.
  broker?: BotBroker;
  // Bid / ask at this account when the buy was sent; missing before 2026-10-25.
  entryBook?: OptionBook;
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
      CREATE TABLE IF NOT EXISTS bot_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        kind TEXT NOT NULL, text TEXT NOT NULL);
    `);
  }

  /** One line of what the bot did, for the app's activity feed; the last 2,000 are kept. */
  addEvent(at: number, kind: BotEventKind, text: string) {
    this.db
      .prepare("INSERT INTO bot_events (at, kind, text) VALUES (?, ?, ?)")
      .run(at, kind, text);
    this.db
      .prepare(
        "DELETE FROM bot_events WHERE id <= (SELECT MAX(id) FROM bot_events) - 2000",
      )
      .run();
  }

  events(limit: number): BotEvent[] {
    return this.db
      .prepare("SELECT at, kind, text FROM bot_events ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as BotEvent[];
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

  /** The picked contract's book on the day's signal of `symbol`. */
  setSignalBook(
    day: string,
    symbol: string,
    book: OptionBook & { contract: string },
  ) {
    const s = this.signal(day, symbol);
    if (!s) return;
    this.db
      .prepare("UPDATE bot_signals SET data = ? WHERE day = ? AND symbol = ?")
      .run(JSON.stringify({ ...s, book }), day, symbol);
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

  /** The signals that entered a position since `since`, for the trade's story. */
  entries(since: string): BotSignal[] {
    return (
      this.db
        .prepare("SELECT data FROM bot_signals WHERE day >= ? ORDER BY id")
        .all(since) as { data: string }[]
    )
      .map((r) => JSON.parse(r.data) as BotSignal)
      .filter((s) => s.outcome === "bought" || s.outcome === "would-buy");
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
