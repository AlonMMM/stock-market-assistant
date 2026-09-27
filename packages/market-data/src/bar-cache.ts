import type { RawBar } from "./bars.js";
import { coreClose, newYork, newYorkToUtc } from "./calendar.js";

// Cache of Alpaca minute bars, one entry per symbol and New York calendar day
// (midnight to midnight, so pre-market and after-hours included). Only days
// that have fully ended, allowing for the data delay, are stored, so cached
// days never change. Storage is pluggable: Cloudflare D1 on the Worker, a
// SQLite file for the local API.
export interface BarCache {
  get(key: string, dates: string[]): Promise<Map<string, RawBar[]>>;
  put(key: string, days: Map<string, RawBar[]>): Promise<void>;
}

export interface CacheStats {
  hits: number; // symbol-days served from the cache
  misses: number; // symbol-days fetched from Alpaca
  errors?: number; // failed cache reads or writes (results stay correct)
  lastError?: string;
}

const recordError = (stats: CacheStats | undefined, error: unknown) => {
  if (!stats) return;
  stats.errors = (stats.errors ?? 0) + 1;
  stats.lastError = error instanceof Error ? error.message : String(error);
};

// Compact storage form: [start, open, high, low, close, volume] per bar.
export const encodeBars = (bars: RawBar[]) =>
  JSON.stringify(
    bars.map((b) => [b.start, b.open, b.high, b.low, b.close, b.volume]),
  );
export const decodeBars = (text: string): RawBar[] =>
  (JSON.parse(text) as number[][]).map(
    ([start, open, high, low, close, volume]) => ({
      start: start!,
      open: open!,
      high: high!,
      low: low!,
      close: close!,
      volume: volume!,
    }),
  );

const nextDate = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const dayStart = (date: string) => newYorkToUtc(date, 0);
const dayEnd = (date: string) => newYorkToUtc(nextDate(date), 0);

/** New York calendar days overlapping [startMs, endMs). */
export function newYorkDates(startMs: number, endMs: number): string[] {
  const dates: string[] = [];
  if (endMs <= startMs) return dates;
  const last = newYork(endMs - 1).date;
  for (let d = newYork(startMs).date; d <= last; d = nextDate(d)) dates.push(d);
  return dates;
}

const isTradingDay = (date: string) => {
  try {
    return coreClose(date) !== null;
  } catch {
    return true; // outside calendar coverage: never assume "no trading"
  }
};

/**
 * History for [start, end) that reads finished days from the cache, fetches
 * only runs of missing days, and stores the finished ones. `readyBefore` is the
 * latest instant with final data (now minus the data delay). Cache failures
 * fall back to fetching.
 */
export async function cachedHistory(
  key: string,
  start: string,
  end: string,
  fetchRange: (start: string, end: string) => Promise<RawBar[]>,
  cache: BarCache,
  readyBefore: number,
  stats?: CacheStats,
): Promise<RawBar[]> {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const dates = newYorkDates(startMs, endMs);
  // A finished day is fetched and stored whole even when the request covers
  // only part of it; the result is trimmed to [start, end) below.
  const finished = (d: string) => dayEnd(d) <= readyBefore;
  let cached = new Map<string, RawBar[]>();
  try {
    cached = await cache.get(key, dates.filter(finished));
  } catch (error) {
    recordError(stats, error); // degrade to fetching everything
  }
  const days = new Map(cached);
  const missing = dates.filter((d) => !cached.has(d));
  // Contiguous runs of missing days, each fetched with one (paged) request.
  const runs: string[][] = [];
  for (const d of missing) {
    const run = runs.at(-1);
    if (run && nextDate(run.at(-1)!) === d) run.push(d);
    else runs.push([d]);
  }
  for (const run of runs) {
    const last = run.at(-1)!;
    const fetchFrom = finished(run[0]!)
      ? dayStart(run[0]!)
      : Math.max(startMs, dayStart(run[0]!));
    const to = finished(last) ? dayEnd(last) : Math.min(endMs, dayEnd(last));
    const rows = await fetchRange(
      new Date(fetchFrom).toISOString(),
      new Date(to).toISOString(),
    );
    const byDay = new Map<string, RawBar[]>(run.map((d) => [d, []]));
    for (const row of rows)
      byDay.get(newYork(row.start * 1000).date)?.push(row);
    const store = new Map<string, RawBar[]>();
    for (const [d, bars] of byDay) {
      days.set(d, bars);
      // An empty trading day is more likely a data gap than a fact: refetch.
      if (finished(d) && (bars.length > 0 || !isTradingDay(d)))
        store.set(d, bars);
    }
    if (stats) stats.misses += run.length;
    if (store.size)
      try {
        await cache.put(key, store);
      } catch (error) {
        recordError(stats, error); // not cached this time; result still correct
      }
  }
  if (stats) stats.hits += cached.size;
  return dates
    .flatMap((d) => days.get(d) ?? [])
    .filter((b) => b.start * 1000 >= startMs && b.start * 1000 < endMs)
    .sort((a, b) => a.start - b.start);
}

/** In-memory cache, for tests. */
export class MemoryBarCache implements BarCache {
  readonly days = new Map<string, string>();
  async get(key: string, dates: string[]) {
    const result = new Map<string, RawBar[]>();
    for (const d of dates) {
      const text = this.days.get(`${key}|${d}`);
      if (text !== undefined) result.set(d, decodeBars(text));
    }
    return result;
  }
  async put(key: string, days: Map<string, RawBar[]>) {
    for (const [d, bars] of days)
      this.days.set(`${key}|${d}`, encodeBars(bars));
  }
}

// Minimal shape of Cloudflare D1 (and of a node:sqlite adapter in tests).
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown>;
}

// Stored form in D1: gzip of the compact JSON, base64 ("gz:" prefix) — about
// a quarter of the size. Plain JSON rows from before are still readable.
async function pack(bars: RawBar[]): Promise<string> {
  const stream = new Blob([encodeBars(bars)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `gz:${btoa(binary)}`;
}
async function unpack(text: string): Promise<RawBar[]> {
  if (!text.startsWith("gz:")) return decodeBars(text);
  const bytes = Uint8Array.from(atob(text.slice(3)), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return decodeBars(await new Response(stream).text());
}
// Days per INSERT: each D1 statement counts against the Workers Free limit of
// 50 subrequests per request (shared with Alpaca calls), so days are written
// several per statement. Real compressed days reach ~21 KB, so 4 per statement
// stays under D1's 100 KB statement limit even if bound values count.
const daysPerInsert = 4;

/** D1-backed cache for the Worker. */
export class D1BarCache implements BarCache {
  private ready?: Promise<unknown>;
  constructor(private db: D1Like) {}
  private init() {
    return (this.ready ??= this.db
      .prepare(
        "CREATE TABLE IF NOT EXISTS minute_bars (key TEXT NOT NULL, date TEXT NOT NULL, bars TEXT NOT NULL, stored_at INTEGER NOT NULL, PRIMARY KEY (key, date))",
      )
      .run());
  }
  async get(key: string, dates: string[]) {
    const result = new Map<string, RawBar[]>();
    if (!dates.length) return result;
    await this.init();
    // One range query per symbol (primary-key range scan); days without a row
    // are the ones to fetch.
    const wanted = new Set(dates);
    const sorted = [...dates].sort();
    const { results } = await this.db
      .prepare(
        "SELECT date, bars FROM minute_bars WHERE key = ? AND date BETWEEN ? AND ?",
      )
      .bind(key, sorted[0], sorted.at(-1))
      .all<{ date: string; bars: string }>();
    for (const row of results)
      if (wanted.has(row.date)) result.set(row.date, await unpack(row.bars));
    return result;
  }
  async put(key: string, days: Map<string, RawBar[]>) {
    await this.init();
    const rows = await Promise.all(
      [...days].map(async ([date, bars]) => [
        key,
        date,
        await pack(bars),
        Date.now(),
      ]),
    );
    const statements = [];
    for (let i = 0; i < rows.length; i += daysPerInsert) {
      const chunk = rows.slice(i, i + daysPerInsert);
      statements.push(
        this.db
          .prepare(
            `INSERT OR REPLACE INTO minute_bars (key, date, bars, stored_at) VALUES ${chunk
              .map(() => "(?, ?, ?, ?)")
              .join(", ")}`,
          )
          .bind(...chunk.flat()),
      );
    }
    if (statements.length) await this.db.batch(statements);
  }
}
