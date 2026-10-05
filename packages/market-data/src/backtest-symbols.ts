// The Backtest page's symbol list: every symbol the user wants available for
// backtests, each marked as a stock or an ETF, kept in D1 (a local SQLite file
// when run locally). Separate from the collector's watchlist, which is also
// the live-alert list.
import type { D1Like } from "./bar-cache.js";
import { tickerPattern } from "./backtest.js";

export const maxListSymbols = 500;
export type SymbolKind = "stock" | "etf";
export interface SymbolList {
  tickers: string[]; // every symbol, sorted
  etfs: string[]; // the ETFs among them; the rest are stocks
  // After a change: whether the live collector now streams the new list.
  live?: { synced: boolean; error?: string };
}

export class D1SymbolList {
  private ready?: Promise<unknown>;
  constructor(private readonly db: D1Like) {}

  private init() {
    return (this.ready ??= (async () => {
      await this.db
        .prepare(
          "CREATE TABLE IF NOT EXISTS backtest_symbols (ticker TEXT PRIMARY KEY, added_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'stock')",
        )
        .run();
      // Lists created before kinds existed get the column (stocks by default).
      const { results } = await this.db
        .prepare("PRAGMA table_info(backtest_symbols)")
        .all<{ name: string }>();
      if (!results.some((c) => c.name === "kind"))
        await this.db
          .prepare(
            "ALTER TABLE backtest_symbols ADD COLUMN kind TEXT NOT NULL DEFAULT 'stock'",
          )
          .run();
    })());
  }

  async list(): Promise<SymbolList> {
    await this.init();
    const { results } = await this.db
      .prepare("SELECT ticker, kind FROM backtest_symbols ORDER BY ticker")
      .all<{ ticker: string; kind: string }>();
    return {
      tickers: results.map((r) => r.ticker),
      etfs: results.filter((r) => r.kind === "etf").map((r) => r.ticker),
    };
  }

  /** Adds (or re-marks) `add` as `kind` and removes `remove`. */
  async change(add: string[], remove: string[], kind: SymbolKind) {
    if (!add.length && !remove.length) return;
    await this.init();
    const now = Date.now();
    await this.db.batch([
      ...add.map((t) =>
        this.db
          .prepare(
            "INSERT INTO backtest_symbols (ticker, added_at, kind) VALUES (?, ?, ?) " +
              "ON CONFLICT (ticker) DO UPDATE SET kind = excluded.kind",
          )
          .bind(t, now, kind),
      ),
      ...remove.map((t) =>
        this.db
          .prepare("DELETE FROM backtest_symbols WHERE ticker = ?")
          .bind(t),
      ),
    ]);
  }
}

/**
 * GET returns the list; POST `{ add?, remove?, kind? }` adds `add` as `kind`
 * (default "stock"; an existing symbol is re-marked), removes `remove`, and
 * returns the updated list.
 */
export async function handleBacktestSymbols(
  method: string,
  body: unknown,
  store?: D1SymbolList,
  // Sends the changed list to the live collector, which streams it.
  push?: (tickers: string[]) => Promise<{ synced: boolean; error?: string }>,
): Promise<{ status: number; body: SymbolList | { error: string } }> {
  if (!store)
    return { status: 503, body: { error: "No database is configured" } };
  if (method === "GET") return { status: 200, body: await store.list() };
  if (method !== "POST")
    return { status: 405, body: { error: "Use GET or POST" } };
  const input = (body ?? {}) as {
    add?: unknown;
    remove?: unknown;
    kind?: unknown;
  };
  const parse = (value: unknown) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((t) => typeof t === "string"))
      return null;
    return [...new Set(value.map((t: string) => t.trim().toUpperCase()))];
  };
  const add = parse(input.add);
  const remove = parse(input.remove);
  const kind = input.kind ?? "stock";
  if (!add || !remove || (kind !== "stock" && kind !== "etf"))
    return {
      status: 400,
      body: {
        error: 'Expected { add?: [], remove?: [], kind?: "stock" | "etf" }',
      },
    };
  const invalid = [...add, ...remove].filter((t) => !tickerPattern.test(t));
  if (invalid.length)
    return {
      status: 400,
      body: { error: `Not US symbols: ${invalid.join(", ")}` },
    };
  const current = (await store.list()).tickers;
  const size = new Set([...current, ...add].filter((t) => !remove.includes(t)))
    .size;
  if (size > maxListSymbols)
    return {
      status: 400,
      body: { error: `The list holds at most ${maxListSymbols} symbols` },
    };
  await store.change(add, remove, kind);
  const list = await store.list();
  if (!push || !list.tickers.length) return { status: 200, body: list };
  return { status: 200, body: { ...list, live: await push(list.tickers) } };
}
