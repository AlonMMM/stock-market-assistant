import { DatabaseSync } from "node:sqlite";

// The prices the bots act on, written down (user 2026-10-28: "need when we
// bought it exactly at what price", "save the seconds before crossing"), in the
// trading service's database: every step of every order, every second of a
// held position, and the volume bot's watch from the alert to the side. The
// Review page replays live trades on them (docs/tasks/backend-price-recorder.md).

export type OrderEvent =
  | "sent" // a new order at the broker
  | "raised" // a buy's limit moved up (the ladder, the chase)
  | "repriced" // a sale's limit moved (to the new bid)
  | "stop-moved"
  | "cancel" // the service asked to cancel it
  | "fill" // some contracts filled, the order still working
  | "filled" // the order is done, all filled
  | "canceled"
  | "expired"
  | "rejected"
  | "replaced"; // done, its rest lives on under another id

export interface OrderStep {
  at: number; // ms, when the service saw it
  account: string;
  orderId: string;
  rootId: string; // the first order of a chain of price changes
  contract: string;
  side: "buy" | "sell" | null; // null: an order sent before the service started
  event: OrderEvent;
  qty: number | null; // contracts asked (sent) or filled in this step (fill / filled)
  limit: number | null; // the order's limit (or stop) after this step
  price: number | null; // this step's own fill price; for "filled" the order's average
  bid: number | null; // the contract's book at that moment (the last quote within 15 s)
  ask: number | null;
  bookAt: number | null;
  filledAt: number | null; // the broker's own time of the full fill, when it says
}

export type TickPhase = "watch" | "held";

export interface PriceTick {
  at: number;
  bot: "main" | "volume";
  ref: string; // the bot's position or trade id
  phase: TickPhase;
  symbol: string;
  stock: number | null; // the stock's last trade
  contract: string | null; // held: the contract
  bid: number | null;
  ask: number | null;
  // watch: the 0.35-delta call and put it would pick, quoted every 5 seconds
  call: string | null;
  callBid: number | null;
  callAsk: number | null;
  put: string | null;
  putBid: number | null;
  putAsk: number | null;
}

interface StepRow {
  at: number;
  account: string;
  order_id: string;
  root_id: string;
  contract: string;
  side: string | null;
  event: string;
  qty: number | null;
  limit_price: number | null;
  price: number | null;
  bid: number | null;
  ask: number | null;
  book_at: number | null;
  filled_at: number | null;
}

interface TickRow {
  at: number;
  bot: string;
  ref: string;
  phase: string;
  symbol: string;
  stock: number | null;
  contract: string | null;
  bid: number | null;
  ask: number | null;
  call: string | null;
  call_bid: number | null;
  call_ask: number | null;
  put: string | null;
  put_bid: number | null;
  put_ask: number | null;
}

const step = (r: StepRow): OrderStep => ({
  at: r.at,
  account: r.account,
  orderId: r.order_id,
  rootId: r.root_id,
  contract: r.contract,
  side: r.side === "buy" || r.side === "sell" ? r.side : null,
  event: r.event as OrderEvent,
  qty: r.qty,
  limit: r.limit_price,
  price: r.price,
  bid: r.bid,
  ask: r.ask,
  bookAt: r.book_at,
  filledAt: r.filled_at,
});

const tick = (r: TickRow): PriceTick => ({
  at: r.at,
  bot: r.bot === "volume" ? "volume" : "main",
  ref: r.ref,
  phase: r.phase === "watch" ? "watch" : "held",
  symbol: r.symbol,
  stock: r.stock,
  contract: r.contract,
  bid: r.bid,
  ask: r.ask,
  call: r.call,
  callBid: r.call_bid,
  callAsk: r.call_ask,
  put: r.put,
  putBid: r.put_bid,
  putAsk: r.put_ask,
});

/** Most rows one read answers: a day of one position is about 23,400. */
export const maxRows = 50_000;

export class RecorderStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS order_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        account TEXT NOT NULL, order_id TEXT NOT NULL, root_id TEXT NOT NULL,
        contract TEXT NOT NULL, side TEXT, event TEXT NOT NULL, qty INTEGER,
        limit_price REAL, price REAL, bid REAL, ask REAL, book_at INTEGER,
        filled_at INTEGER);
      CREATE INDEX IF NOT EXISTS order_steps_at ON order_steps (at);
      CREATE INDEX IF NOT EXISTS order_steps_contract ON order_steps (contract, at);
      CREATE TABLE IF NOT EXISTS position_ticks (
        at INTEGER NOT NULL, bot TEXT NOT NULL, ref TEXT NOT NULL,
        phase TEXT NOT NULL, symbol TEXT NOT NULL, stock REAL,
        contract TEXT, bid REAL, ask REAL,
        call TEXT, call_bid REAL, call_ask REAL,
        put TEXT, put_bid REAL, put_ask REAL);
      CREATE INDEX IF NOT EXISTS position_ticks_ref ON position_ticks (ref, at);
      CREATE INDEX IF NOT EXISTS position_ticks_at ON position_ticks (at);
    `);
  }

  close() {
    this.db.close();
  }

  addStep(s: OrderStep) {
    this.db
      .prepare(
        `INSERT INTO order_steps (at, account, order_id, root_id, contract, side,
          event, qty, limit_price, price, bid, ask, book_at, filled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.at,
        s.account,
        s.orderId,
        s.rootId,
        s.contract,
        s.side,
        s.event,
        s.qty,
        s.limit,
        s.price,
        s.bid,
        s.ask,
        s.bookAt,
        s.filledAt,
      );
  }

  /** One tick's rows together. */
  addTicks(ticks: PriceTick[]) {
    if (!ticks.length) return;
    const insert = this.db.prepare(
      `INSERT INTO position_ticks (at, bot, ref, phase, symbol, stock, contract,
        bid, ask, call, call_bid, call_ask, put, put_bid, put_ask)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      for (const t of ticks)
        insert.run(
          t.at,
          t.bot,
          t.ref,
          t.phase,
          t.symbol,
          t.stock,
          t.contract,
          t.bid,
          t.ask,
          t.call,
          t.callBid,
          t.callAsk,
          t.put,
          t.putBid,
          t.putAsk,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Order steps from `from` to `to` (ms), optionally of one contract, oldest first. */
  steps(from: number, to: number, contract?: string): OrderStep[] {
    const rows = contract
      ? this.db
          .prepare(
            "SELECT * FROM order_steps WHERE contract = ? AND at >= ? AND at < ? ORDER BY at, id LIMIT ?",
          )
          .all(contract, from, to, maxRows)
      : this.db
          .prepare(
            "SELECT * FROM order_steps WHERE at >= ? AND at < ? ORDER BY at, id LIMIT ?",
          )
          .all(from, to, maxRows);
    return (rows as unknown as StepRow[]).map(step);
  }

  /** Ticks of one position or trade, or of everything from `from` to `to`, oldest first. */
  ticks(query: { ref: string } | { from: number; to: number }): PriceTick[] {
    const rows =
      "ref" in query
        ? this.db
            .prepare(
              "SELECT * FROM position_ticks WHERE ref = ? ORDER BY at LIMIT ?",
            )
            .all(query.ref, maxRows)
        : this.db
            .prepare(
              "SELECT * FROM position_ticks WHERE at >= ? AND at < ? ORDER BY at LIMIT ?",
            )
            .all(query.from, query.to, maxRows);
    return (rows as unknown as TickRow[]).map(tick);
  }

  /** Deletes rows older than `before` (ms); the number of rows removed. */
  prune(before: number): number {
    const a = this.db
      .prepare("DELETE FROM order_steps WHERE at < ?")
      .run(before).changes;
    const b = this.db
      .prepare("DELETE FROM position_ticks WHERE at < ?")
      .run(before).changes;
    return Number(a) + Number(b);
  }
}
