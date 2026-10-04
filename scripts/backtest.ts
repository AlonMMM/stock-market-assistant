// Offline backtest: the site's /api/backtest for many symbols and long ranges.
// Symbols run one at a time with no Worker memory or CPU limits, and look-now
// scores are ranked against the random minutes of all symbols together.
//
// Bars come from data/local/bars-cache.sqlite, then the D1 cache (copied into
// the local file), then Alpaca for anything still missing (stored locally
// only). Daily bars for β come from Alpaca; without keys, β is assumed.
//
//   railway run -- node --import tsx scripts/backtest.ts [options]
// Options:
//   --symbols-file path     one symbol per line (default: --symbols)
//   --symbols A,B,C
//   --from YYYY-MM-DD       default: 252 sessions before --to
//   --to YYYY-MM-DD         default: the last complete session
//   --config '{"threshold":3}'   rule overrides, as on the Backtest page
//   --out path              default: data/local/backtest-<from>_<to>.json
//   --wrangler <path>       wrangler binary (default: wrangler on PATH)
//   --no-cache 1            recompute every symbol
//
// Each symbol's computed part is cached in the backtest_parts table of
// data/local/bars-cache.sqlite. Its key hashes everything the part depends on:
// the rule version (ruleVersion, e.g. rvol-v4), the evaluation sources (so a
// fix within a version never reuses stale parts), the dates, rule and scoring
// settings, and the symbol. A rerun recomputes only uncached symbols, then
// ranks look-now scores across all. rule and ticker are kept as plain columns
// for listing and cleanup, e.g. DELETE FROM backtest_parts WHERE rule = 'rvol-v3'.
//
// Each complete run is stored in backtest_runs: the same hash over the sorted
// symbol list instead of one symbol, readable columns (rule, dates, symbols,
// settings, summary) and the full gzipped result. An identical rerun is served
// from it; a run with failed symbols is not stored.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { ruleVersion } from "../packages/alerts/src/relative-volume.js";
import { fileURLToPath } from "node:url";
import { AlpacaFeed } from "../packages/market-data/src/alpaca.js";
import {
  backtestWindow,
  BacktestInputError,
  BacktestRun,
  decodePart,
  encodePart,
  minuteHistory,
  parseBacktest,
  type BacktestRequest,
  type BacktestResult,
  type SymbolPart,
} from "../packages/market-data/src/backtest.js";
import {
  D1BarCache,
  type BarCache,
  type D1Like,
  type D1Statement,
} from "../packages/market-data/src/bar-cache.js";
import type { RawBar } from "../packages/market-data/src/bars.js";
import { benchmark } from "../packages/market-data/src/beta.js";
import {
  newYork,
  previousSessions,
} from "../packages/market-data/src/calendar.js";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");

const symbols = (
  args.has("symbols-file")
    ? readFileSync(args.get("symbols-file")!, "utf8").split(/\s+/)
    : (args.get("symbols") ?? "").split(",")
)
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const now = Date.now();
// The last session whose data is final: yesterday's or earlier.
const to = args.get("to") ?? previousSessions(newYork(now).date, 1)[0]!;
const from = args.get("from") ?? previousSessions(to, 251)[0]!;
const out = args.get("out") ?? `${root}data/local/backtest-${from}_${to}.json`;
const wrangler = args.get("wrangler") ?? "wrangler";

let request: BacktestRequest;
try {
  request = parseBacktest(
    {
      tickers: [...new Set(symbols)],
      from,
      to,
      config: args.has("config") ? JSON.parse(args.get("config")!) : undefined,
    },
    now,
    false,
  );
} catch (error) {
  if (!(error instanceof BacktestInputError)) throw error;
  console.error(`${error.message}. Usage: see the header of this script.`);
  process.exit(2);
}

// Read-only D1 through wrangler: bound values are inlined as SQL literals.
const quote = (v: unknown) =>
  typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`;
const remoteD1: D1Like = {
  prepare(sql: string) {
    const statement = (params: unknown[]): D1Statement => ({
      bind: (...values) => statement(values),
      all: async <T>() => {
        let i = 0;
        const command = sql.replace(/\?/g, () => quote(params[i++]));
        const text = execFileSync(
          wrangler,
          [
            "d1",
            "execute",
            "sma-bars-cache",
            "--remote",
            "--json",
            "--command",
            command,
          ],
          { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
        );
        return {
          results: JSON.parse(text.slice(text.indexOf("[")))[0].results as T[],
        };
      },
      run: async () => ({}), // only the cache's CREATE TABLE; nothing is written to D1
    });
    return statement([]);
  },
  async batch() {},
};
mkdirSync(`${root}data/local`, { recursive: true });
const local = new D1BarCache(
  new SqliteD1(`${root}data/local/bars-cache.sqlite`),
);
const remote = new D1BarCache(remoteD1);
const cache: BarCache = {
  async get(key, dates) {
    const days = await local.get(key, dates);
    const missing = dates.filter((d) => !days.has(d));
    if (missing.length) {
      const fetched = await remote.get(key, missing);
      if (fetched.size) await local.put(key, fetched);
      for (const [d, bars] of fetched) days.set(d, bars);
    }
    return days;
  },
  put: (key, days) => local.put(key, days),
};

const key = process.env.ALPACA_API_KEY;
const secret = process.env.ALPACA_API_SECRET;
const feed =
  key && secret ? new AlpacaFeed(key, secret, "sip", () => {}) : null;
const offline: Pick<AlpacaFeed, "history"> = {
  history: async (ticker) => {
    throw new Error(
      `${ticker}: bars missing from the caches and no Alpaca keys`,
    );
  },
};
const history = minuteHistory((feed ?? offline) as AlpacaFeed, cache, now);
const window = backtestWindow(request, now);
const daily = async (ticker: string): Promise<RawBar[]> =>
  feed && window.betaStart
    ? feed.history(
        ticker,
        `${window.betaStart}T00:00:00Z`,
        `${to}T00:00:00Z`,
        "1Day",
        "split",
      )
    : [];
if (!feed) console.warn("No Alpaca keys: β is assumed and missing bars fail.");

const began = Date.now();
console.log(
  `Backtesting ${request.tickers.length} symbols, ${request.sessions.length} sessions ` +
    `(${from} → ${to}), ${request.config.days} warmup sessions`,
);
// Per-symbol cache of computed parts (see the header).
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const code = sha(
  [
    "packages/alerts/src/relative-volume.ts",
    "packages/contracts/src/vs-spy.ts",
    "packages/market-data/src/alert-vs-spy.ts",
    "packages/market-data/src/backtest.ts",
    "packages/market-data/src/bars.ts",
    "packages/market-data/src/beta.ts",
    "packages/market-data/src/calendar.ts",
    "packages/market-data/src/evaluator.ts",
    "packages/market-data/src/look-now.ts",
    "packages/market-data/src/outcome.ts",
    "packages/market-data/src/rs-score.ts",
  ]
    .map((f) => readFileSync(`${root}${f}`, "utf8"))
    .join("\0"),
);
const partKey = (ticker: string) =>
  sha(
    JSON.stringify({
      rule: ruleVersion,
      code,
      from,
      to,
      window,
      config: request.config,
      validation: request.validation,
      ticker,
    }),
  );
const runKey = sha(
  JSON.stringify({
    rule: ruleVersion,
    code,
    from,
    to,
    window,
    config: request.config,
    validation: request.validation,
    tickers: [...request.tickers].sort(),
  }),
);
const db = new DatabaseSync(`${root}data/local/bars-cache.sqlite`);
db.exec(`PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS backtest_parts (key TEXT PRIMARY KEY, rule TEXT NOT NULL,
    ticker TEXT NOT NULL, part BLOB NOT NULL, stored_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS backtest_runs (key TEXT PRIMARY KEY, rule TEXT NOT NULL,
    from_date TEXT NOT NULL, to_date TEXT NOT NULL, symbols TEXT NOT NULL,
    settings TEXT NOT NULL, summary TEXT NOT NULL, result BLOB NOT NULL,
    created_at INTEGER NOT NULL);`);
const savePart = (part: SymbolPart) =>
  db
    .prepare(
      "INSERT OR REPLACE INTO backtest_parts (key, rule, ticker, part, stored_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      partKey(part.ticker),
      ruleVersion,
      part.ticker,
      gzipSync(encodePart(part)),
      Date.now(),
    );
const loadPart = (ticker: string) => {
  const row = db
    .prepare("SELECT part FROM backtest_parts WHERE key = ?")
    .get(partKey(ticker)) as { part: Uint8Array } | undefined;
  // Listed as cached at start; SPY was not loaded for it, so it must exist.
  if (!row) throw new Error("cached part removed during the run; rerun");
  return decodePart(gunzipSync(row.part).toString());
};
const useCache = args.get("no-cache") === undefined;
const storedRun = useCache
  ? (db
      .prepare("SELECT result FROM backtest_runs WHERE key = ?")
      .get(runKey) as { result: Uint8Array } | undefined)
  : undefined;
const failed: string[] = [];
let result: BacktestResult;
if (storedRun) {
  console.log(`Rule ${ruleVersion}: identical run found in backtest_runs`);
  result = JSON.parse(gunzipSync(storedRun.result).toString());
} else {
  result = await computeRun();
  // A run with failed symbols is incomplete: never served as cached.
  if (!failed.length)
    db.prepare(
      `INSERT OR REPLACE INTO backtest_runs (key, rule, from_date, to_date, symbols,
        settings, summary, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runKey,
      ruleVersion,
      from,
      to,
      JSON.stringify(request.tickers),
      JSON.stringify({
        config: request.config,
        validation: request.validation,
      }),
      JSON.stringify({
        alerts: result.alerts.length,
        evaluated: result.evaluated,
        lookNow: result.lookNow,
        validation: { ...result.validation, baselineBySymbol: undefined },
        diagnostics: result.diagnostics,
      }),
      gzipSync(JSON.stringify(result)),
      Date.now(),
    );
}
writeFileSync(out, JSON.stringify(result));

async function computeRun() {
  const has = db.prepare("SELECT 1 FROM backtest_parts WHERE key = ?");
  const cached = new Set(
    useCache ? request.tickers.filter((t) => has.get(partKey(t))) : [],
  );
  console.log(
    `Rule ${ruleVersion}: ${cached.size} of ${request.tickers.length} symbols cached`,
  );
  // SPY's bars are only needed to compute uncached symbols.
  const needed = cached.size < request.tickers.length;
  const spyRows = needed
    ? await history(benchmark, window.start, window.until)
    : [];
  const run = new BacktestRun(
    request,
    window,
    spyRows,
    needed ? await daily(benchmark) : [],
  );
  for (const [i, ticker] of request.tickers.entries()) {
    try {
      if (cached.has(ticker)) {
        run.merge(loadPart(ticker));
        continue;
      }
      const rows =
        ticker === benchmark
          ? spyRows
          : await history(ticker, window.start, window.until);
      const computed = run.compute(
        ticker,
        rows,
        ticker === benchmark ? [] : await daily(ticker),
      );
      savePart(computed);
      run.merge(computed);
    } catch (error) {
      failed.push(ticker);
      console.error(
        `${ticker}: ${error instanceof Error ? error.message : error}`,
      );
      continue;
    }
    console.log(
      `[${i + 1}/${request.tickers.length}] ${ticker} · ${Math.round((Date.now() - began) / 1000)} s`,
    );
  }
  return run.finish();
}

const pct = (n: number, d: number) =>
  d ? `${((n / d) * 100).toFixed(1)}%` : "—";
const fixed = (n: number | null) => (n === null ? "—" : n.toFixed(1));
const v = result.validation;
const l = result.lookNow!;
const scoredLines = [
  `Done in ${Math.round((Date.now() - began) / 1000)} s · ${result.alerts.length} alerts ` +
    `from ${result.evaluated.toLocaleString("en-US")} evaluations · ${out}`,
  `Look-now: average ${fixed(l.averageScore)} vs baseline ${fixed(l.baseline.averageScore)}; ` +
    `big ${pct(l.big, l.scored)} vs ${pct(l.baseline.big, l.baseline.scored)}; ` +
    `very big ${pct(l.veryBig, l.scored)} vs ${pct(l.baseline.veryBig, l.baseline.scored)} ` +
    `(${l.scored} scored, ${l.unscored} unscored)`,
  `Trade view: good ${pct(v.good, v.scored)} vs baseline ${pct(v.baseline.good, v.baseline.scored)}; ` +
    `stopped ${pct(v.stopped, v.scored)} vs ${pct(v.baseline.stopped, v.baseline.scored)}`,
];
const bySymbol = new Map<string, number>();
for (const a of result.alerts)
  bySymbol.set(a.ticker, (bySymbol.get(a.ticker) ?? 0) + 1);
const top = [...bySymbol].sort((a, b) => b[1] - a[1]).slice(0, 10);
scoredLines.push(`Most alerts: ${top.map(([t, n]) => `${t} ${n}`).join(", ")}`);
const gaps = result.coverage.filter((c) => c.missingSessions.length);
if (gaps.length)
  scoredLines.push(
    `Missing sessions: ${gaps.map((c) => `${c.ticker} ${c.missingSessions.length}`).join(", ")}`,
  );
console.log(scoredLines.join("\n"));
if (failed.length) {
  console.error(`Failed: ${failed.join(", ")}`);
  process.exitCode = 1;
}
