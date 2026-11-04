// The Backtest page's setup, kept per viewer on the server (the user,
// 2026-11-04: "do not cache the settings - save them on backend as i see
// different setting in different device"): the page saves it with its Save
// button and every device opens with it. The setup itself is the page's
// (BotBacktest.tsx Setup); the page fills what is missing with its defaults.
import type { D1Like } from "./bar-cache.js";

export const maxSetupChars = 65536;

export interface SavedSetup {
  setup: Record<string, unknown>;
  savedAt: number;
}

export class D1BacktestSetups {
  // True once the table exists. Never the promise itself: on Workers a D1
  // call started by one request hangs forever when another awaits it.
  private ready = false;
  constructor(private readonly db: D1Like) {}

  private async init() {
    if (this.ready) return;
    await this.db
      .prepare(
        "CREATE TABLE IF NOT EXISTS backtest_setups (owner TEXT PRIMARY KEY, setup TEXT NOT NULL, saved_at INTEGER NOT NULL)",
      )
      .run();
    this.ready = true;
  }

  async get(owner: string): Promise<SavedSetup | null> {
    await this.init();
    const { results } = await this.db
      .prepare("SELECT setup, saved_at FROM backtest_setups WHERE owner = ?")
      .bind(owner)
      .all<{ setup: string; saved_at: number }>();
    const row = results[0];
    if (!row) return null;
    return { setup: JSON.parse(row.setup), savedAt: Number(row.saved_at) };
  }

  async put(owner: string, setup: Record<string, unknown>, now: number) {
    await this.init();
    await this.db
      .prepare(
        "INSERT INTO backtest_setups (owner, setup, saved_at) VALUES (?, ?, ?) " +
          "ON CONFLICT (owner) DO UPDATE SET setup = excluded.setup, saved_at = excluded.saved_at",
      )
      .bind(owner, JSON.stringify(setup), now)
      .run();
  }
}

/**
 * GET /api/backtest-setup  → { setup, savedAt } (404: nothing saved yet)
 * PUT /api/backtest-setup  { setup } → { setup, savedAt }
 */
export async function handleBacktestSetup(o: {
  method: string;
  body: unknown;
  owner: string; // the signed-in email, "" without sign-in
  store: D1BacktestSetups | undefined;
  now?: number;
}): Promise<{ status: number; body: unknown }> {
  if (!o.store)
    return {
      status: 503,
      body: { error: "The setup store is not configured" },
    };
  if (o.method === "GET") {
    const saved = await o.store.get(o.owner);
    if (!saved) return { status: 404, body: { error: "No saved setup" } };
    return { status: 200, body: saved };
  }
  if (o.method !== "PUT")
    return { status: 405, body: { error: "Method not allowed (GET, PUT)" } };
  const setup = (o.body as { setup?: unknown } | null)?.setup;
  if (!setup || typeof setup !== "object" || Array.isArray(setup))
    return { status: 400, body: { error: "setup must be an object" } };
  if (JSON.stringify(setup).length > maxSetupChars)
    return { status: 413, body: { error: "setup is too large" } };
  const now = o.now ?? Date.now();
  await o.store.put(o.owner, setup as Record<string, unknown>, now);
  return { status: 200, body: { setup, savedAt: now } };
}
