// Named watchlists (user 2026-10-17: "support multiple watchlists"), kept in
// D1 (a local SQLite file when run locally). Each is an ordered list of
// symbols for the Watchlist section to show. They do not change what the live
// collector streams or alerts on: that is the engine list
// (backtest-symbols.ts), offered here as the built-in list "all", which is
// read-only through this API and edited where it always was.
import type { D1Like } from "./bar-cache.js";
import { tickerPattern } from "./backtest.js";

export const maxWatchlists = 20;
export const maxWatchlistSymbols = 200;
export const maxNameLength = 40;
export const engineListId = "all";

export interface Watchlist {
  id: string;
  name: string;
  tickers: string[]; // in the user's order
  // The engine list: every streamed symbol; not editable here.
  builtIn?: true;
}

const idPattern = /^[a-z0-9]{8,32}$/;

export class D1Watchlists {
  private ready?: Promise<unknown>;
  constructor(private readonly db: D1Like) {}

  private init() {
    return (this.ready ??= this.db.batch([
      this.db.prepare(
        "CREATE TABLE IF NOT EXISTS watchlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL, created_at INTEGER NOT NULL)",
      ),
      this.db.prepare(
        "CREATE TABLE IF NOT EXISTS watchlist_symbols (watchlist_id TEXT NOT NULL, ticker TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (watchlist_id, ticker))",
      ),
    ]));
  }

  async lists(): Promise<Watchlist[]> {
    await this.init();
    const [{ results: lists }, { results: rows }] = await Promise.all([
      this.db
        .prepare(
          "SELECT id, name FROM watchlists ORDER BY position, created_at",
        )
        .all<{ id: string; name: string }>(),
      this.db
        .prepare(
          "SELECT watchlist_id AS id, ticker FROM watchlist_symbols ORDER BY position",
        )
        .all<{ id: string; ticker: string }>(),
    ]);
    const tickers = new Map<string, string[]>(lists.map((l) => [l.id, []]));
    for (const r of rows) tickers.get(r.id)?.push(r.ticker);
    return lists.map((l) => ({
      id: l.id,
      name: l.name,
      tickers: tickers.get(l.id) ?? [],
    }));
  }

  async get(id: string): Promise<Watchlist | null> {
    return (await this.lists()).find((l) => l.id === id) ?? null;
  }

  async create(id: string, name: string, tickers: string[], now: number) {
    await this.init();
    const { results } = await this.db
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM watchlists")
      .all<{ next: number }>();
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO watchlists (id, name, position, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(id, name, results[0]?.next ?? 0, now),
      ...this.rows(id, tickers),
    ]);
  }

  private rows(id: string, tickers: string[]) {
    return tickers.map((t, i) =>
      this.db
        .prepare(
          "INSERT INTO watchlist_symbols (watchlist_id, ticker, position) VALUES (?, ?, ?)",
        )
        .bind(id, t, i),
    );
  }

  /** Renames and/or replaces the symbols (in their new order). */
  async update(id: string, change: { name?: string; tickers?: string[] }) {
    await this.init();
    await this.db.batch([
      ...(change.name === undefined
        ? []
        : [
            this.db
              .prepare("UPDATE watchlists SET name = ? WHERE id = ?")
              .bind(change.name, id),
          ]),
      ...(change.tickers === undefined
        ? []
        : [
            this.db
              .prepare("DELETE FROM watchlist_symbols WHERE watchlist_id = ?")
              .bind(id),
            ...this.rows(id, change.tickers),
          ]),
    ]);
  }

  async remove(id: string) {
    await this.init();
    await this.db.batch([
      this.db
        .prepare("DELETE FROM watchlist_symbols WHERE watchlist_id = ?")
        .bind(id),
      this.db.prepare("DELETE FROM watchlists WHERE id = ?").bind(id),
    ]);
  }

  /** The lists in this order; ids not named keep their place after them. */
  async reorder(ids: string[]) {
    if (!ids.length) return;
    await this.init();
    await this.db.batch(
      ids.map((id, i) =>
        this.db
          .prepare("UPDATE watchlists SET position = ? WHERE id = ?")
          .bind(i, id),
      ),
    );
  }
}

type Answer = { status: number; body: unknown };
const bad = (error: string, status = 400): Answer => ({
  status,
  body: { error },
});

/** Upper-cased, unique, in the order given; null when not a list of strings. */
function symbols(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((t) => typeof t === "string"))
    return null;
  return [...new Set(value.map((t: string) => t.trim().toUpperCase()))];
}

function checkSymbols(
  tickers: string[],
  removed: string[] = [],
): Answer | null {
  const invalid = [...tickers, ...removed].filter(
    (t) => !tickerPattern.test(t),
  );
  if (invalid.length) return bad(`Not US symbols: ${invalid.join(", ")}`);
  if (tickers.length > maxWatchlistSymbols)
    return bad(`A watchlist holds at most ${maxWatchlistSymbols} symbols`);
  return null;
}

function checkName(value: unknown, taken: Watchlist[]): string | Answer {
  if (typeof value !== "string") return bad("name must be text");
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) return bad("name must not be empty");
  if (name.length > maxNameLength)
    return bad(`name is at most ${maxNameLength} characters`);
  if (
    name.toLowerCase() === "all" ||
    taken.some((l) => l.name.toLowerCase() === name.toLowerCase())
  )
    return bad(`A watchlist named "${name}" already exists`, 409);
  return name;
}

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

/**
 * `GET    /api/watchlists`: `{ lists }`, the engine list "all" first.
 * `POST   /api/watchlists` `{ name, tickers? }`: creates one; answers it.
 * `POST   /api/watchlists/order` `{ ids }`: the order of the user's lists.
 * `GET    /api/watchlists/<id>`: one list.
 * `PATCH  /api/watchlists/<id>` `{ name?, tickers?, add?, remove? }`:
 *   `tickers` replaces the symbols in that order; `add` appends and `remove`
 *   takes out. Answers the list.
 * `DELETE /api/watchlists/<id>`.
 * `engine` is the engine list's symbols; the built-in list cannot change here.
 */
export async function handleWatchlists(
  method: string,
  // Under /api/watchlists: "" or "<id>" or "order".
  sub: string,
  body: unknown,
  store: D1Watchlists | undefined,
  engine: () => Promise<string[]>,
  now = Date.now(),
): Promise<Answer> {
  if (!store) return bad("No database is configured", 503);
  const input = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;
  const builtIn = async (): Promise<Watchlist> => ({
    id: engineListId,
    name: "All",
    tickers: await engine(),
    builtIn: true,
  });
  if (sub === "") {
    if (method === "GET")
      return {
        status: 200,
        body: { lists: [await builtIn(), ...(await store.lists())] },
      };
    if (method !== "POST") return bad("Use GET or POST", 405);
    const lists = await store.lists();
    if (lists.length >= maxWatchlists)
      return bad(`At most ${maxWatchlists} watchlists`, 409);
    const name = checkName(input.name, lists);
    if (typeof name !== "string") return name;
    const tickers = input.tickers === undefined ? [] : symbols(input.tickers);
    if (!tickers) return bad("tickers must be a list of symbols");
    const wrong = checkSymbols(tickers);
    if (wrong) return wrong;
    const id = newId();
    await store.create(id, name, tickers, now);
    return { status: 201, body: await store.get(id) };
  }
  if (sub === "order") {
    if (method !== "POST") return bad("Use POST", 405);
    const ids = input.ids;
    const lists = await store.lists();
    if (
      !Array.isArray(ids) ||
      !ids.every((id) => typeof id === "string") ||
      new Set(ids).size !== ids.length ||
      !ids.every((id) => lists.some((l) => l.id === id))
    )
      return bad("ids must name each of your watchlists once");
    const rest = lists.map((l) => l.id).filter((id) => !ids.includes(id));
    await store.reorder([...(ids as string[]), ...rest]);
    return {
      status: 200,
      body: { lists: [await builtIn(), ...(await store.lists())] },
    };
  }
  if (sub === engineListId) {
    if (method === "GET") return { status: 200, body: await builtIn() };
    return bad(
      'The "All" list is the alert engine\'s list; change it under Manage engine tickers',
      409,
    );
  }
  if (!idPattern.test(sub)) return bad("No such watchlist", 404);
  const list = await store.get(sub);
  if (!list) return bad("No such watchlist", 404);
  if (method === "GET") return { status: 200, body: list };
  if (method === "DELETE") {
    await store.remove(sub);
    return { status: 200, body: { deleted: sub } };
  }
  if (method !== "PATCH") return bad("Use GET, PATCH or DELETE", 405);
  const change: { name?: string; tickers?: string[] } = {};
  if (input.name !== undefined) {
    const others = (await store.lists()).filter((l) => l.id !== sub);
    const name = checkName(input.name, others);
    if (typeof name !== "string") return name;
    change.name = name;
  }
  const replace =
    input.tickers === undefined ? undefined : symbols(input.tickers);
  const add = input.add === undefined ? [] : symbols(input.add);
  const remove = input.remove === undefined ? [] : symbols(input.remove);
  if (replace === null || !add || !remove)
    return bad("tickers, add and remove must be lists of symbols");
  if (input.tickers !== undefined || add.length || remove.length) {
    const base = replace ?? list.tickers;
    const tickers = [...base, ...add.filter((t) => !base.includes(t))].filter(
      (t) => !remove.includes(t),
    );
    const wrong = checkSymbols(tickers, remove);
    if (wrong) return wrong;
    change.tickers = tickers;
  }
  if (change.name === undefined && change.tickers === undefined)
    return bad("Nothing to change: give name, tickers, add or remove");
  await store.update(sub, change);
  return { status: 200, body: await store.get(sub) };
}

/**
 * The symbols the board shows for `?list=`: the engine list when absent or
 * "all", else that watchlist's; null when there is no such list.
 */
export async function boardTickers(
  list: string | null,
  store: D1Watchlists | undefined,
  engine: () => Promise<string[]>,
): Promise<string[] | null> {
  if (!list || list === engineListId) return engine();
  if (!store || !idPattern.test(list)) return null;
  return (await store.get(list))?.tickers ?? null;
}

/**
 * Every symbol on any watchlist is also on the engine list, the pool the
 * collector streams and alerts on (user 2026-10-19: "if I add to one of the
 * lists it goes to the pool of tickers"). Adds the missing ones and answers
 * them; it never removes: the pool may hold symbols of its own.
 */
export async function syncPool(
  lists: D1Watchlists,
  pool: {
    list(): Promise<{ tickers: string[] }>;
    change(add: string[], remove: string[], kind: "stock"): Promise<unknown>;
  },
): Promise<string[]> {
  const [all, current] = await Promise.all([lists.lists(), pool.list()]);
  const have = new Set(current.tickers);
  const missing = [
    ...new Set(all.flatMap((l) => l.tickers).filter((t) => !have.has(t))),
  ];
  if (missing.length) await pool.change(missing, [], "stock");
  return missing;
}
