import { DatabaseSync } from "node:sqlite";
import type {
  BuyLog,
  BuyRecord,
  PostStore,
} from "../../../packages/trading/src/engine.js";
import type {
  Decision,
  DecisionLog,
} from "../../../packages/trading/src/explain.js";

// The trading service's records (docs/tasks/backend-trading-service.md).
// Every row has an owner, so more traders can be added without a rewrite.

export type JobKind = "buy" | "sell";
export type JobState = "running" | "done" | "failed" | "interrupted";

export interface Job {
  id: string;
  userId: string;
  kind: JobKind;
  symbol: string;
  state: JobState;
  request: unknown;
  result: unknown;
  createdAt: number;
  updatedAt: number;
}

interface JobRow {
  id: string;
  user_id: string;
  kind: JobKind;
  symbol: string;
  state: JobState;
  request: string;
  result: string | null;
  created_at: number;
  updated_at: number;
}

const job = (r: JobRow): Job => ({
  id: r.id,
  userId: r.user_id,
  kind: r.kind,
  symbol: r.symbol,
  state: r.state,
  request: JSON.parse(r.request),
  result: r.result === null ? null : JSON.parse(r.result),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class TradeStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
        symbol TEXT NOT NULL, state TEXT NOT NULL, request TEXT NOT NULL,
        result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS posts (
        user_id TEXT NOT NULL, symbol TEXT NOT NULL, ref TEXT NOT NULL,
        PRIMARY KEY (user_id, symbol));
      CREATE TABLE IF NOT EXISTS buys (
        id TEXT NOT NULL, user_id TEXT NOT NULL, day TEXT NOT NULL,
        symbol TEXT NOT NULL, at INTEGER NOT NULL, filled INTEGER,
        PRIMARY KEY (user_id, id));
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL,
        symbol TEXT NOT NULL, outcome TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (user_id, id));
      CREATE TABLE IF NOT EXISTS notes (
        user_id TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (user_id, name));
      CREATE TABLE IF NOT EXISTS log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        user_id TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL,
        outcome TEXT NOT NULL);
    `);
  }

  close() {
    this.db.close();
  }

  createJob(
    j: Pick<Job, "id" | "userId" | "kind" | "symbol" | "request">,
    now: number,
  ) {
    this.db
      .prepare(
        "INSERT INTO jobs (id, user_id, kind, symbol, state, request, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)",
      )
      .run(
        j.id,
        j.userId,
        j.kind,
        j.symbol,
        JSON.stringify(j.request),
        now,
        now,
      );
  }

  finishJob(id: string, state: JobState, result: unknown, now: number) {
    this.db
      .prepare(
        "UPDATE jobs SET state = ?, result = ?, updated_at = ? WHERE id = ?",
      )
      .run(state, JSON.stringify(result ?? null), now, id);
  }

  job(userId: string, id: string): Job | undefined {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE user_id = ? AND id = ?")
      .get(userId, id) as JobRow | undefined;
    return row && job(row);
  }

  runningJobs(): Job[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM jobs WHERE state = 'running' ORDER BY created_at",
        )
        .all() as unknown as JobRow[]
    ).map(job);
  }

  /** The post of each open trade of one user. */
  posts(userId: string): PostStore {
    const db = this.db;
    return {
      async get(symbol) {
        const row = db
          .prepare("SELECT ref FROM posts WHERE user_id = ? AND symbol = ?")
          .get(userId, symbol) as { ref: string } | undefined;
        return row?.ref;
      },
      async set(symbol, ref) {
        if (ref === null)
          db.prepare("DELETE FROM posts WHERE user_id = ? AND symbol = ?").run(
            userId,
            symbol,
          );
        else
          db.prepare(
            "INSERT OR REPLACE INTO posts (user_id, symbol, ref) VALUES (?, ?, ?)",
          ).run(userId, symbol, ref);
      },
    };
  }

  /** The buys of each day of one user. */
  buys(userId: string): BuyLog {
    const db = this.db;
    return {
      async list(day) {
        const rows = db
          .prepare(
            "SELECT id, day, symbol, at, filled FROM buys WHERE user_id = ? AND day = ? ORDER BY at",
          )
          .all(userId, day) as unknown as (Omit<BuyRecord, "filled"> & {
          filled: number | null;
        })[];
        return rows.map((r) => ({
          ...r,
          filled: r.filled === null ? null : r.filled === 1,
        }));
      },
      async put(r) {
        db.prepare(
          "INSERT OR REPLACE INTO buys (id, user_id, day, symbol, at, filled) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          r.id,
          userId,
          r.day,
          r.symbol,
          r.at,
          r.filled === null ? null : r.filled ? 1 : 0,
        );
      },
    };
  }

  /** Why each buy of one user looks the way it does. */
  decisions(userId: string): DecisionLog {
    const db = this.db;
    return {
      async put(d) {
        db.prepare(
          "INSERT OR REPLACE INTO decisions (id, user_id, at, symbol, outcome, data) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(d.id, userId, d.at, d.symbol, d.outcome, JSON.stringify(d));
      },
    };
  }

  /** The latest decisions of one user, newest first. */
  recentDecisions(userId: string, limit: number): Decision[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM decisions WHERE user_id = ? ORDER BY at DESC LIMIT ?",
        )
        .all(userId, limit) as unknown as { data: string }[]
    ).map((r) => JSON.parse(r.data) as Decision);
  }

  /** A small named record of one user, such as the stops being watched. */
  note<T>(userId: string, name: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM notes WHERE user_id = ? AND name = ?")
      .get(userId, name) as { data: string } | undefined;
    return row && (JSON.parse(row.data) as T);
  }

  setNote(userId: string, name: string, value: unknown) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO notes (user_id, name, data) VALUES (?, ?, ?)",
      )
      .run(userId, name, JSON.stringify(value));
  }

  log(
    at: number,
    userId: string,
    tool: string,
    input: unknown,
    outcome: string,
  ) {
    this.db
      .prepare(
        "INSERT INTO log (at, user_id, tool, input, outcome) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        at,
        userId,
        tool,
        JSON.stringify(input ?? null),
        outcome.slice(0, 500),
      );
  }

  recentLog(limit = 50) {
    return this.db
      .prepare(
        "SELECT at, user_id, tool, input, outcome FROM log ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as unknown as {
      at: number;
      user_id: string;
      tool: string;
      input: string;
      outcome: string;
    }[];
  }
}
