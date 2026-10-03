// Typical regular-session cumulative volume for the board's Rel vol
// (docs/features/live-page.md, "Rel vol"). Built from 5-minute bars of the
// previous sessions and reduced to one small curve per symbol and board date,
// which is stored so later polls that day need no history request.
import type { RawBar } from "./bars.js";
import { coreClose, newYork } from "./calendar.js";
import type { D1Like } from "./bar-cache.js";

export const baselineSessions = 20; // previous sessions examined
export const baselineMinimum = 15; // sessions needed for a typical value
export const baselineStep = 5; // minutes per mark (5-minute bars)
const open = 570; // 09:30 New York
const lastMark = 960; // 16:00 New York, the latest regular close

/**
 * typical[k] is the median cumulative regular-session volume from 09:30 to
 * New York minute 570 + 5 × (k + 1) over the previous sessions; null when
 * fewer than `baselineMinimum` sessions were open at that minute with data.
 */
export type VolumeCurve = (number | null)[];

const marks = (lastMark - open) / baselineStep;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Regular-session volume per 5-minute slot of one session's bars. */
function slots(rows: RawBar[], date: string, close: number): number[] | null {
  const result = new Array<number>((close - open) / baselineStep).fill(0);
  let any = false;
  for (const row of rows) {
    const at = newYork(row.start * 1000);
    if (at.date !== date || at.minute < open || at.minute >= close) continue;
    result[Math.floor((at.minute - open) / baselineStep)]! += row.volume;
    any = true;
  }
  return any ? result : null;
}

/**
 * Curve from 5-minute bars of `sessions` (earlier than the board date). A
 * session without regular bars counts as missing; a session counts at a mark
 * only if its regular session was still open then (early closes).
 */
export function volumeCurve(rows: RawBar[], sessions: string[]): VolumeCurve {
  const byMark: number[][] = Array.from({ length: marks }, () => []);
  for (const date of sessions) {
    const close = coreClose(date);
    if (close === null) continue;
    const volumes = slots(rows, date, close);
    if (!volumes) continue;
    let total = 0;
    volumes.forEach((v, k) => {
      total += v;
      byMark[k]!.push(total);
    });
  }
  return byMark.map((values) =>
    values.length >= baselineMinimum ? median(values) : null,
  );
}

/** Typical cumulative volume at a New York minute (a 5-minute mark). */
export function typicalAt(curve: VolumeCurve, minute: number): number | null {
  const k = (minute - open) / baselineStep - 1;
  return Number.isInteger(k) && k >= 0 && k < curve.length
    ? (curve[k] ?? null)
    : null;
}

/** Small per-symbol values stored per board date; one round trip each. */
export interface DailyStore<T> {
  get(date: string, tickers: string[]): Promise<Map<string, T>>;
  put(date: string, values: Map<string, T>): Promise<void>;
}

/** Stored curves per board date; reads and writes are one round trip each. */
export type BaselineStore = DailyStore<VolumeCurve>;

/** In-memory store, for tests. */
export class MemoryDailyStore<T> implements DailyStore<T> {
  readonly rows = new Map<string, T>();
  async get(date: string, tickers: string[]) {
    const result = new Map<string, T>();
    for (const t of tickers) {
      const value = this.rows.get(`${date}|${t}`);
      if (value !== undefined) result.set(t, value);
    }
    return result;
  }
  async put(date: string, values: Map<string, T>) {
    for (const [t, value] of values) this.rows.set(`${date}|${t}`, value);
  }
}
export class MemoryBaselineStore extends MemoryDailyStore<VolumeCurve> {}

// Rows per INSERT: 4 bound values each stays under D1's 100-parameter limit.
const rowsPerInsert = 20;

/**
 * D1 table of JSON values per (date, ticker), in the bar-cache database: one
 * query per board poll. Older dates are dropped on write.
 */
export class D1DailyStore<T> implements DailyStore<T> {
  private ready?: Promise<unknown>;
  constructor(
    private db: D1Like,
    private table: string,
    private column: string,
  ) {}
  private init() {
    return (this.ready ??= this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${this.table} (date TEXT NOT NULL, ticker TEXT NOT NULL, ${this.column} TEXT NOT NULL, stored_at INTEGER NOT NULL, PRIMARY KEY (date, ticker))`,
      )
      .run());
  }
  async get(date: string, tickers: string[]) {
    const result = new Map<string, T>();
    if (!tickers.length) return result;
    await this.init();
    const wanted = new Set(tickers);
    const { results } = await this.db
      .prepare(
        `SELECT ticker, ${this.column} AS value FROM ${this.table} WHERE date = ?`,
      )
      .bind(date)
      .all<{ ticker: string; value: string }>();
    for (const row of results)
      if (wanted.has(row.ticker))
        result.set(row.ticker, JSON.parse(row.value) as T);
    return result;
  }
  async put(date: string, values: Map<string, T>) {
    if (!values.size) return;
    await this.init();
    const rows = [...values].map(([t, value]) => [
      date,
      t,
      JSON.stringify(value),
      Date.now(),
    ]);
    // Older board dates are never read again; drop them in the same batch.
    const statements = [
      this.db.prepare(`DELETE FROM ${this.table} WHERE date < ?`).bind(date),
    ];
    for (let i = 0; i < rows.length; i += rowsPerInsert) {
      const chunk = rows.slice(i, i + rowsPerInsert);
      statements.push(
        this.db
          .prepare(
            `INSERT OR REPLACE INTO ${this.table} (date, ticker, ${this.column}, stored_at) VALUES ${chunk
              .map(() => "(?, ?, ?, ?)")
              .join(", ")}`,
          )
          .bind(...chunk.flat()),
      );
    }
    await this.db.batch(statements);
  }
}

/** Rel vol curves (the bar-cache database's volume_baselines table). */
export class D1BaselineStore extends D1DailyStore<VolumeCurve> {
  constructor(db: D1Like) {
    super(db, "volume_baselines", "curve");
  }
}
