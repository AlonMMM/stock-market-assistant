import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  D1Like,
  D1Statement,
} from "../../../packages/market-data/src/bar-cache.js";

// node:sqlite behind the small D1 interface the bar cache uses, so the local
// API (and tests) run the same cache code as the Worker.
export class SqliteD1 implements D1Like {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  }
  prepare(sql: string): D1Statement {
    const db = this.db;
    const statement = (params: unknown[]): D1Statement => ({
      bind: (...values) => statement(values),
      all: async <T>() => ({
        results: db.prepare(sql).all(...(params as SQLInputValue[])) as T[],
      }),
      run: async () => db.prepare(sql).run(...(params as SQLInputValue[])),
    });
    return statement([]);
  }
  // Batches run one at a time: two concurrent batches (e.g. the board's
  // stores writing in parallel) would otherwise nest BEGIN and fail.
  private queue: Promise<unknown> = Promise.resolve();
  async batch(statements: D1Statement[]) {
    const run = this.queue.then(async () => {
      this.db.exec("BEGIN");
      try {
        for (const s of statements) await s.run();
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }
  close() {
    this.db.close();
  }
}
