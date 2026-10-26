import type { AccountRisk } from "../../../packages/trading/src/account-risk.js";
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

export type JobKind =
  "buy" | "sell" | "stock-buy" | "stock-sell" | "spread" | "spread-close";
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

// Traders, their broker accounts and where they are notified
// (docs/features/multi-user-ibkr.md). Secrets inside `credentials` and
// `config` are references (see secrets.ts), never plain values.

export type BrokerName = "alpaca" | "ibkr";
export type AccountMode = "paper" | "live";
export const providers = ["telegram", "whatsapp", "discord", "email"] as const;
export type Provider = (typeof providers)[number];

export interface User {
  id: string;
  email: string | null;
  name: string;
  enabled: boolean;
  isAdmin: boolean;
  // A pointer into the validator registry; null means the user cannot buy.
  validatorId: string | null;
  validatorParams: Record<string, unknown> | null;
  createdAt: number;
}

export interface BrokerAccount {
  id: string;
  userId: string;
  broker: BrokerName;
  mode: AccountMode;
  isDefault: boolean;
  credentials: Record<string, unknown>;
  gatewayUrl: string | null; // ibkr: that user's Gateway on the private network
  enabled: boolean;
  createdAt: number;
}

export interface Channel {
  id: string;
  userId: string;
  provider: Provider;
  config: Record<string, unknown>;
  events: string[] | null; // null: every event
  enabled: boolean;
  createdAt: number;
}

interface UserRow {
  id: string;
  email: string | null;
  name: string;
  enabled: number;
  is_admin: number;
  validator_id: string | null;
  validator_params: string | null;
  created_at: number;
}
interface AccountRow {
  id: string;
  user_id: string;
  broker: BrokerName;
  mode: AccountMode;
  is_default: number;
  credentials: string;
  gateway_url: string | null;
  enabled: number;
  created_at: number;
}
interface ChannelRow {
  id: string;
  user_id: string;
  provider: Provider;
  config: string;
  events: string | null;
  enabled: number;
  created_at: number;
}

const user = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  enabled: r.enabled === 1,
  isAdmin: r.is_admin === 1,
  validatorId: r.validator_id,
  validatorParams:
    r.validator_params === null ? null : JSON.parse(r.validator_params),
  createdAt: r.created_at,
});
const account = (r: AccountRow): BrokerAccount => ({
  id: r.id,
  userId: r.user_id,
  broker: r.broker,
  mode: r.mode,
  isDefault: r.is_default === 1,
  credentials: JSON.parse(r.credentials),
  gatewayUrl: r.gateway_url,
  enabled: r.enabled === 1,
  createdAt: r.created_at,
});
const channel = (r: ChannelRow): Channel => ({
  id: r.id,
  userId: r.user_id,
  provider: r.provider,
  config: JSON.parse(r.config),
  events: r.events === null ? null : JSON.parse(r.events),
  enabled: r.enabled === 1,
  createdAt: r.created_at,
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
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT NOT NULL,
        enabled INTEGER NOT NULL, is_admin INTEGER NOT NULL,
        validator_id TEXT, validator_params TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS broker_accounts (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, broker TEXT NOT NULL,
        mode TEXT NOT NULL, is_default INTEGER NOT NULL,
        credentials TEXT NOT NULL, gateway_url TEXT,
        enabled INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_channels (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL,
        config TEXT NOT NULL, events TEXT, enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS equity_days (
        account_id TEXT NOT NULL, date TEXT NOT NULL, equity REAL NOT NULL,
        at INTEGER NOT NULL, PRIMARY KEY (account_id, date));
      CREATE TABLE IF NOT EXISTS account_risk (
        account_id TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL);
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

  /** Running jobs of one user, or of every user when none is named. */
  runningJobs(userId?: string): Job[] {
    const rows =
      userId === undefined
        ? this.db
            .prepare(
              "SELECT * FROM jobs WHERE state = 'running' ORDER BY created_at",
            )
            .all()
        : this.db
            .prepare(
              "SELECT * FROM jobs WHERE state = 'running' AND user_id = ? ORDER BY created_at",
            )
            .all(userId);
    return (rows as unknown as JobRow[]).map(job);
  }

  addUser(u: Omit<User, "createdAt">, now: number) {
    this.db
      .prepare(
        "INSERT INTO users (id, email, name, enabled, is_admin, validator_id, validator_params, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        u.id,
        u.email?.toLowerCase() ?? null,
        u.name,
        u.enabled ? 1 : 0,
        u.isAdmin ? 1 : 0,
        u.validatorId,
        u.validatorParams === null ? null : JSON.stringify(u.validatorParams),
        now,
      );
  }

  users(): User[] {
    return (
      this.db
        .prepare("SELECT * FROM users ORDER BY created_at, id")
        .all() as unknown as UserRow[]
    ).map(user);
  }

  /** A user by id or by email (any case). */
  findUser(idOrEmail: string): User | undefined {
    const row = this.db
      .prepare("SELECT * FROM users WHERE id = ? OR email = ?")
      .get(idOrEmail, idOrEmail.toLowerCase()) as UserRow | undefined;
    return row && user(row);
  }

  addAccount(a: Omit<BrokerAccount, "createdAt">, now: number) {
    this.db
      .prepare(
        "INSERT INTO broker_accounts (id, user_id, broker, mode, is_default, credentials, gateway_url, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        a.id,
        a.userId,
        a.broker,
        a.mode,
        a.isDefault ? 1 : 0,
        JSON.stringify(a.credentials),
        a.gatewayUrl,
        a.enabled ? 1 : 0,
        now,
      );
  }

  accounts(userId: string): BrokerAccount[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM broker_accounts WHERE user_id = ? ORDER BY is_default DESC, created_at, id",
        )
        .all(userId) as unknown as AccountRow[]
    ).map(account);
  }

  addChannel(c: Omit<Channel, "createdAt">, now: number) {
    this.db
      .prepare(
        "INSERT INTO notification_channels (id, user_id, provider, config, events, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        c.id,
        c.userId,
        c.provider,
        JSON.stringify(c.config),
        c.events === null ? null : JSON.stringify(c.events),
        c.enabled ? 1 : 0,
        now,
      );
  }

  channels(userId: string): Channel[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM notification_channels WHERE user_id = ? ORDER BY created_at, id",
        )
        .all(userId) as unknown as ChannelRow[]
    ).map(channel);
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

  /**
   * The account's value on a trading day (New York date), for brokers with no
   * history of their own (docs/tasks/backend-bot-ibkr.md). The day's last
   * write wins, so after the close the row is the closing value.
   */
  recordEquity(accountId: string, date: string, equity: number, now: number) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO equity_days (account_id, date, equity, at) VALUES (?, ?, ?, ?)",
      )
      .run(accountId, date, equity, now);
  }

  /** The recorded daily values of one account, oldest first. */
  equityDays(accountId: string): { date: string; equity: number }[] {
    // Plain objects: node:sqlite's rows have no prototype.
    return (
      this.db
        .prepare(
          "SELECT date, equity FROM equity_days WHERE account_id = ? ORDER BY date",
        )
        .all(accountId) as unknown as { date: string; equity: number }[]
    ).map((r) => ({ date: r.date, equity: r.equity }));
  }

  /** The owner's risk settings of one account (account-risk.ts); null: the defaults. */
  accountRisk(accountId: string): Partial<AccountRisk> | null {
    const row = this.db
      .prepare("SELECT data FROM account_risk WHERE account_id = ?")
      .get(accountId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Partial<AccountRisk>) : null;
  }

  setAccountRisk(accountId: string, risk: AccountRisk, now: number) {
    this.db
      .prepare(
        "INSERT INTO account_risk (account_id, data, at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET data = excluded.data, at = excluded.at",
      )
      .run(accountId, JSON.stringify(risk), now);
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
