// Backfills the bar cache (Cloudflare D1, or the local SQLite file) with Alpaca
// SIP minute bars for the IBKR watchlist, SPY, QQQ and the sector benchmarks.
// Uses the same rules as the live cache (finished days only, gaps not stored,
// compressed, 10 days per insert) and skips symbol-days already cached.
//
// Run with the Railway collector's variables (Alpaca keys, collector token):
//   railway run -- node --import tsx scripts/backfill-bars.ts [options]
// Options:
//   --months 3              history to fill, counted back from today
//   --rate 100              max Alpaca requests per minute (free plan: 200)
//   --target d1|local       live D1 via wrangler, or data/local/bars-cache.sqlite
//   --wrangler <path>       wrangler binary (default: wrangler on PATH)
//   --symbols A,B,C         instead of the watchlist
//   --no-benchmarks         skip SPY, QQQ and the sector ETFs
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AlpacaFeed } from "../packages/market-data/src/alpaca.js";
import {
  parseSipDelay,
  sipDelayMs,
} from "../packages/market-data/src/sip-delay.js";
import {
  cachedHistory,
  D1BarCache,
  type BarCache,
  type CacheStats,
  type D1Like,
  type D1Statement,
} from "../packages/market-data/src/bar-cache.js";
import type { RawBar } from "../packages/market-data/src/bars.js";
import { loadWatchlist } from "../packages/market-data/src/watchlist.js";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const [flag, value] = [process.argv[i]!, process.argv[i + 1]];
  if (flag === "--no-benchmarks") args.set("no-benchmarks", "1");
  else if (flag.startsWith("--") && value !== undefined) {
    args.set(flag.slice(2), value);
    i++;
  }
}
const months = Number(args.get("months") ?? 3);
const rate = Number(args.get("rate") ?? 100);
const target = args.get("target") ?? "d1";
const wrangler = args.get("wrangler") ?? "wrangler";
if (!(months > 0 && months <= 24) || !(rate > 0 && rate <= 200))
  throw new Error("--months must be 1–24 and --rate 1–200");
if (!["d1", "local"].includes(target)) throw new Error("--target d1|local");
const key = process.env.ALPACA_API_KEY;
const secret = process.env.ALPACA_API_SECRET;
if (!key || !secret)
  throw new Error("Set ALPACA_API_KEY and ALPACA_API_SECRET");

// Paces every Alpaca HTTP request (pages included) to `rate` per minute.
let nextSlot = 0;
let requests = 0;
const paced = (async (input: URL | RequestInfo, init?: RequestInit) => {
  const wait = nextSlot - Date.now();
  nextSlot = Math.max(Date.now(), nextSlot) + 60000 / rate;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  requests++;
  return fetch(input, init);
}) as typeof fetch;
const feed = new AlpacaFeed(key, secret, "sip", () => {}, paced);

// Symbols: the synced IBKR watchlist (from the collector) plus benchmarks.
const list = await loadWatchlist({
  url:
    process.env.COLLECTOR_URL ??
    "https://market-collector-production-b05d.up.railway.app",
  token: process.env.COLLECTOR_TOKEN,
});
const symbols = args.get("symbols")
  ? args
      .get("symbols")!
      .split(",")
      .map((s) => s.trim().toUpperCase())
  : [
      ...new Set([
        ...list.tickers,
        ...(args.has("no-benchmarks")
          ? []
          : ["SPY", "QQQ", ...Object.values(list.benchmarks)]),
      ]),
    ];
if (!args.get("symbols") && list.source !== "ibkr")
  console.warn("Collector watchlist unavailable; using the default list.");

// Only data past the SIP delay (ALPACA_SIP_DELAY_MINUTES) is final.
const readyBefore =
  Date.now() - sipDelayMs(parseSipDelay(process.env.ALPACA_SIP_DELAY_MINUTES));
const start = new Date(readyBefore);
start.setUTCMonth(start.getUTCMonth() - months);
const range = [
  `${start.toISOString().slice(0, 10)}T00:00:00Z`,
  new Date(readyBefore).toISOString(),
] as const;

// Existing symbol-days, so only missing ones are fetched.
const d1 = (sql: string) =>
  execFileSync(
    wrangler,
    ["d1", "execute", "sma-bars-cache", "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
const existing = new Set<string>();
let local: SqliteD1 | undefined;
if (target === "d1") {
  const out = d1(
    `SELECT key, date FROM minute_bars WHERE date >= '${range[0].slice(0, 10)}'`,
  );
  const rows = JSON.parse(out.slice(out.indexOf("[")))[0].results as {
    key: string;
    date: string;
  }[];
  for (const r of rows) existing.add(`${r.key}|${r.date}`);
} else {
  const path = "data/local/bars-cache.sqlite";
  mkdirSync(dirname(path), { recursive: true });
  local = new SqliteD1(path);
}

// D1 target: record the cache's statements as SQL and apply them with wrangler.
const sql: string[] = [];
const quote = (v: unknown) =>
  typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`;
const recorder: D1Like = {
  prepare(text: string) {
    const statement = (params: unknown[]): D1Statement => ({
      bind: (...values) => statement(values),
      all: async <T>() => ({ results: [] as T[] }),
      run: async () => {
        // One statement per day: values are inline in a SQL file, and D1
        // limits each statement to 100 KB (the file import itself is not
        // subject to the Worker's per-request limits).
        if (text.startsWith("INSERT"))
          for (let i = 0; i < params.length; i += 4)
            sql.push(
              `INSERT OR REPLACE INTO minute_bars (key, date, bars, stored_at) VALUES (${params
                .slice(i, i + 4)
                .map(quote)
                .join(", ")});`,
            );
      },
    });
    return statement([]);
  },
  async batch(statements) {
    for (const s of statements) await s.run();
  },
};
const store = local ? new D1BarCache(local) : new D1BarCache(recorder);
const cache: BarCache = local
  ? store
  : {
      // Days already in D1 count as cached; their bars are not needed here.
      get: async (k, dates) =>
        new Map(
          dates.filter((d) => existing.has(`${k}|${d}`)).map((d) => [d, []]),
        ),
      put: (k, days) => store.put(k, days),
    };

const totals: CacheStats = { hits: 0, misses: 0 };
const failed: string[] = [];
const dir = mkdtempSync(join(tmpdir(), "backfill-"));
const began = Date.now();
console.log(
  `Backfilling ${symbols.length} symbols, ${range[0].slice(0, 10)} → today, ` +
    `≤ ${rate} Alpaca requests/min, target ${target}`,
);
try {
  for (const [n, symbol] of symbols.entries()) {
    const stats: CacheStats = { hits: 0, misses: 0 };
    let rows: RawBar[] = [];
    try {
      rows = await cachedHistory(
        `${symbol}:sip:1Min:raw`,
        ...range,
        (s, e) => feed.history(symbol, s, e),
        cache,
        readyBefore,
        stats,
      );
    } catch (error) {
      console.error(
        `${symbol}: ${error instanceof Error ? error.message : error}`,
      );
      continue;
    }
    if (sql.length) {
      const file = join(dir, `${symbol}.sql`);
      writeFileSync(file, sql.join("\n"));
      sql.length = 0;
      // Retry transient import failures; a symbol that still fails is
      // reported and picked up by the next run.
      let imported = false;
      for (let attempt = 1; attempt <= 3 && !imported; attempt++)
        try {
          execFileSync(
            wrangler,
            [
              "d1",
              "execute",
              "sma-bars-cache",
              "--remote",
              "--yes",
              "--file",
              file,
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          );
          imported = true;
        } catch (error) {
          const detail = String(
            (error as { stderr?: string; stdout?: string }).stderr ||
              (error as { stdout?: string }).stdout ||
              error,
          )
            .trim()
            .split("\n")
            .filter((line) => line.trim())
            .slice(-3)
            .join(" | ");
          console.error(
            `${symbol}: D1 import attempt ${attempt} failed: ${detail}`,
          );
          if (attempt < 3)
            await new Promise((r) => setTimeout(r, 5000 * attempt));
        }
      if (!imported) {
        failed.push(symbol);
        continue;
      }
    }
    if (stats.errors)
      console.error(`${symbol}: cache error ${stats.lastError}`);
    totals.hits += stats.hits;
    totals.misses += stats.misses;
    console.log(
      `[${n + 1}/${symbols.length}] ${symbol}: ${stats.misses} days fetched ` +
        `(${rows.length} bars), ${stats.hits} already cached · ${requests} requests · ` +
        `${Math.round((Date.now() - began) / 1000)} s`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
  local?.close();
}
console.log(
  `Done: ${totals.misses} symbol-days fetched, ${totals.hits} already cached, ` +
    `${requests} Alpaca requests in ${Math.round((Date.now() - began) / 1000)} s.`,
);
if (failed.length) {
  console.error(`Not stored (rerun to retry): ${failed.join(", ")}`);
  process.exitCode = 1;
}
