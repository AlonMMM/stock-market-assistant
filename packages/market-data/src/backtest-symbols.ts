// The Backtest page's symbol list: every symbol the user wants available for
// backtests, kept in D1 (a local SQLite file when run locally). Separate from
// the collector's watchlist, which is also the live-alert list.
import type { D1Like } from "./bar-cache.js";
import { tickerPattern } from "./backtest.js";

export const maxListSymbols = 500;

export class D1SymbolList {
  private ready?: Promise<unknown>;
  constructor(private readonly db: D1Like) {}

  private init() {
    return (this.ready ??= this.db
      .prepare(
        "CREATE TABLE IF NOT EXISTS backtest_symbols (ticker TEXT PRIMARY KEY, added_at INTEGER NOT NULL)",
      )
      .run());
  }

  async list(): Promise<string[]> {
    await this.init();
    const { results } = await this.db
      .prepare("SELECT ticker FROM backtest_symbols ORDER BY ticker")
      .all<{ ticker: string }>();
    return results.map((r) => r.ticker);
  }

  async change(add: string[], remove: string[]) {
    if (!add.length && !remove.length) return;
    await this.init();
    const now = Date.now();
    await this.db.batch([
      ...add.map((t) =>
        this.db
          .prepare(
            "INSERT OR IGNORE INTO backtest_symbols (ticker, added_at) VALUES (?, ?)",
          )
          .bind(t, now),
      ),
      ...remove.map((t) =>
        this.db
          .prepare("DELETE FROM backtest_symbols WHERE ticker = ?")
          .bind(t),
      ),
    ]);
  }
}

/** GET returns the list; POST `{ add?, remove? }` changes it and returns it. */
export async function handleBacktestSymbols(
  method: string,
  body: unknown,
  store?: D1SymbolList,
): Promise<{
  status: number;
  body: { tickers: string[] } | { error: string };
}> {
  if (!store)
    return { status: 503, body: { error: "No database is configured" } };
  if (method === "GET")
    return { status: 200, body: { tickers: await store.list() } };
  if (method !== "POST")
    return { status: 405, body: { error: "Use GET or POST" } };
  const input = (body ?? {}) as { add?: unknown; remove?: unknown };
  const parse = (value: unknown) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((t) => typeof t === "string"))
      return null;
    return [...new Set(value.map((t: string) => t.trim().toUpperCase()))];
  };
  const add = parse(input.add);
  const remove = parse(input.remove);
  if (!add || !remove)
    return {
      status: 400,
      body: { error: "Expected { add?: [], remove?: [] }" },
    };
  const invalid = [...add, ...remove].filter((t) => !tickerPattern.test(t));
  if (invalid.length)
    return {
      status: 400,
      body: { error: `Not US symbols: ${invalid.join(", ")}` },
    };
  const current = await store.list();
  const size = new Set([...current, ...add].filter((t) => !remove.includes(t)))
    .size;
  if (size > maxListSymbols)
    return {
      status: 400,
      body: { error: `The list holds at most ${maxListSymbols} symbols` },
    };
  await store.change(add, remove);
  return { status: 200, body: { tickers: await store.list() } };
}
