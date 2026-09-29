import { DatabaseSync } from "node:sqlite";
import type { AlertEvents } from "../../alerts/src/events.js";
import { formatAlert, type Alert, type Sender } from "./telegram.js";

// pending → sending → sent | failed | expired; muted when queued while muted.
// A row left in `sending` by a crash becomes `unknown` and is never resent:
// Telegram may already have delivered it.
export type NotificationStatus =
  "pending" | "sending" | "sent" | "failed" | "expired" | "muted" | "unknown";

export interface NotificationRow {
  ticker: string;
  end: string;
  status: NotificationStatus;
  attempts: number;
  error: string | null;
  sentAt: string | null;
}

export interface OutboxOptions {
  maxAttempts?: number;
  // An alert older than this is not sent; it is no longer actionable.
  maxAgeMs?: number;
  baseDelayMs?: number;
  siteUrl?: string;
  now?: () => number;
}

// Durable delivery queue in the collector's SQLite file, keyed like `alerts`
// so an alert is queued at most once.
export class Outbox {
  private db: DatabaseSync;
  private maxAttempts: number;
  private maxAgeMs: number;
  private baseDelayMs: number;
  private now: () => number;
  private draining: Promise<void> | null = null;
  constructor(
    path: string,
    private sender: Sender,
    private options: OutboxOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.maxAgeMs = options.maxAgeMs ?? 15 * 60000;
    this.baseDelayMs = options.baseDelayMs ?? 5000;
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS notifications (ticker TEXT, end TEXT, payload TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
        error TEXT, sent_at TEXT, PRIMARY KEY(ticker,end));
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      UPDATE notifications SET status='unknown' WHERE status='sending';`);
    // Added for analysis replies; older databases lack the column.
    const columns = this.db.prepare("PRAGMA table_info(notifications)").all();
    if (!columns.some((c) => c.name === "message_id"))
      this.db.exec("ALTER TABLE notifications ADD COLUMN message_id INTEGER");
  }
  muted(): boolean {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key='notifications.muted'")
      .get();
    return row?.value === "true";
  }
  setMuted(muted: boolean) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES ('notifications.muted',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(String(muted));
  }
  // Queues an alert unless it was queued before. Muted alerts are recorded
  // but not sent later, so unmuting does not replay a backlog.
  enqueue(alert: Alert): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO notifications (ticker, end, payload, status, attempts, next_at) VALUES (?,?,?,?,0,?)",
      )
      .run(
        alert.ticker,
        alert.end,
        JSON.stringify(alert),
        this.muted() ? "muted" : "pending",
        this.now(),
      );
    return result.changes > 0;
  }
  // Telegram message id of a sent alert, for threading follow-ups under it.
  messageId(ticker: string, end: string): number | null {
    const row = this.db
      .prepare(
        "SELECT message_id FROM notifications WHERE ticker=? AND end=? AND status='sent'",
      )
      .get(ticker, end);
    return typeof row?.message_id === "number" ? row.message_id : null;
  }
  recent(limit = 50): NotificationRow[] {
    return this.db
      .prepare(
        "SELECT ticker, end, status, attempts, error, sent_at FROM notifications ORDER BY end DESC LIMIT ?",
      )
      .all(limit)
      .map((r) => ({
        ticker: String(r.ticker),
        end: String(r.end),
        status: r.status as NotificationStatus,
        attempts: Number(r.attempts),
        error: r.error === null ? null : String(r.error),
        sentAt: r.sent_at === null ? null : String(r.sent_at),
      }));
  }
  // Sends due rows one at a time. Concurrent calls share one pass.
  drain(): Promise<void> {
    this.draining ??= this.pass().finally(() => (this.draining = null));
    return this.draining;
  }
  private async pass() {
    const due = this.db.prepare(
      "SELECT ticker, end, payload, attempts FROM notifications WHERE status='pending' AND next_at<=? ORDER BY end LIMIT 1",
    );
    const update = this.db.prepare(
      "UPDATE notifications SET status=?, attempts=?, next_at=?, error=?, sent_at=? WHERE ticker=? AND end=?",
    );
    const sent = this.db.prepare(
      "UPDATE notifications SET message_id=? WHERE ticker=? AND end=?",
    );
    for (;;) {
      const row = due.get(this.now());
      if (!row) return;
      const ticker = String(row.ticker);
      const end = String(row.end);
      const attempts = Number(row.attempts) + 1;
      const alert = JSON.parse(String(row.payload)) as Alert;
      if (this.now() - Date.parse(alert.end) > this.maxAgeMs) {
        update.run(
          "expired",
          attempts - 1,
          0,
          "Too old to send",
          null,
          ticker,
          end,
        );
        continue;
      }
      update.run("sending", attempts, 0, null, null, ticker, end);
      const result = await this.sender.send(
        formatAlert(alert, this.options.siteUrl),
      );
      if (result.ok) {
        sent.run(result.messageId ?? null, ticker, end);
        update.run(
          "sent",
          attempts,
          0,
          null,
          new Date(this.now()).toISOString(),
          ticker,
          end,
        );
        continue;
      }
      const final = !result.retry || attempts >= this.maxAttempts;
      const wait =
        result.retryAfter !== undefined
          ? result.retryAfter * 1000
          : this.baseDelayMs * 3 ** (attempts - 1);
      update.run(
        final ? "failed" : "pending",
        attempts,
        this.now() + wait,
        result.error,
        null,
        ticker,
        end,
      );
      console.error(
        JSON.stringify({
          event: "notification-failed",
          ticker,
          end,
          attempts,
          final,
          error: result.error,
        }),
      );
    }
  }
  close() {
    this.db.close();
  }
}

// Queues every published alert for delivery. Returns the unsubscribe function.
export function notifyOnAlerts(events: AlertEvents, outbox: Outbox) {
  return events.subscribe("telegram", (alert) => {
    if (outbox.enqueue(alert)) return outbox.drain();
  });
}
