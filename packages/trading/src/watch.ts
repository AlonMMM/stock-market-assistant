import type { D1Like } from "../../market-data/src/bar-cache.js";
import { handlePortfolio, PortfolioCache } from "./portfolio.js";

// Hard rule (user, 2026-10-10): the account must never be short an option.
// The hosted Worker runs this every minute, so a short position is reported
// to the trades channel even when no command runs and the site is closed.

export interface WatchState {
  problems: string; // the last findings sent; "" when the account was clean
  at: number; // when they were sent
  failures: number; // checks that failed in a row
}

export interface WatchStore {
  load(): Promise<WatchState>;
  save(state: WatchState): Promise<void>;
}

const clean: WatchState = { problems: "", at: 0, failures: 0 };

export class MemoryWatchStore implements WatchStore {
  private state = clean;
  async load() {
    return this.state;
  }
  async save(state: WatchState) {
    this.state = state;
  }
}

export class D1WatchStore implements WatchStore {
  private ready?: Promise<unknown>;
  constructor(private readonly db: D1Like) {}

  private init() {
    return (this.ready ??= this.db
      .prepare(
        "CREATE TABLE IF NOT EXISTS short_watch (id INTEGER PRIMARY KEY, problems TEXT NOT NULL, at INTEGER NOT NULL, failures INTEGER NOT NULL)",
      )
      .run());
  }

  async load(): Promise<WatchState> {
    await this.init();
    const { results } = await this.db
      .prepare("SELECT problems, at, failures FROM short_watch WHERE id = 1")
      .all<WatchState>();
    return results[0] ?? clean;
  }

  async save(state: WatchState) {
    await this.init();
    await this.db
      .prepare(
        "INSERT OR REPLACE INTO short_watch (id, problems, at, failures) VALUES (1, ?, ?, ?)",
      )
      .bind(state.problems, state.at, state.failures)
      .run();
  }
}

// An unchanged finding is repeated this often until it is gone.
export const repeatMs = 15 * 60_000;
// A failing check is reported once it has failed this many times in a row.
export const failuresToReport = 5;

export interface WatchOptions {
  credentials: { key?: string; secret?: string };
  live?: boolean;
  store: WatchStore;
  // Sends one HTML message to the trades channel; false when it was not sent.
  send: (html: string) => Promise<boolean>;
  fetcher?: typeof fetch;
  now?: number;
}

/** One check of the account. Returns a line for the Worker's log. */
export async function watchShort(options: WatchOptions): Promise<string> {
  const { store, send, live = false, now = Date.now() } = options;
  const tag = live ? "" : " (paper)";
  const last = await store.load();
  const result = await handlePortfolio(
    options.credentials,
    live,
    options.fetcher,
    now,
    new PortfolioCache(),
  );
  if (!("shortRisks" in result.body)) {
    const failures = last.failures + 1;
    const report = failures === failuresToReport;
    // A report that could not be sent is tried again on the next check.
    const sent =
      !report ||
      (await send(
        `⚠️ <b>The short-position check is failing</b>${tag}\n${result.body.error}`,
      ));
    await store.save({ ...last, failures: sent ? failures : failures - 1 });
    return `check failed (${failures} in a row): ${result.body.error}`;
  }
  const problems = result.body.shortRisks.join("\n");
  const recovered = last.failures >= failuresToReport;
  let message: string | undefined;
  if (problems) {
    if (problems !== last.problems || now - last.at >= repeatMs)
      message = `🚨 <b>SHORT OPTION RISK</b>${tag}\n${problems}`;
  } else if (last.problems)
    message = `✅ <b>Short option risk is gone</b>${tag}\nNo short positions and no oversized sell orders.`;
  else if (recovered)
    message = `✅ <b>The short-position check works again</b>${tag}`;
  if (message === undefined) {
    if (last.failures > 0) await store.save({ ...last, failures: 0 });
    return problems ? `still at risk: ${problems}` : "clean";
  }
  if (!(await send(message)))
    return `ALERT NOT SENT: ${problems || "account is clean again"}`;
  await store.save({ problems, at: now, failures: 0 });
  return problems ? `alert sent: ${problems}` : "clean again, sent";
}
