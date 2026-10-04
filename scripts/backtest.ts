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
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AlpacaFeed } from "../packages/market-data/src/alpaca.js";
import {
  backtestWindow,
  BacktestInputError,
  BacktestRun,
  minuteHistory,
  parseBacktest,
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

let request;
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
const spyRows = await history(benchmark, window.start, window.until);
const run = new BacktestRun(request, window, spyRows, await daily(benchmark));
const failed: string[] = [];
for (const [i, ticker] of request.tickers.entries()) {
  try {
    const rows =
      ticker === benchmark
        ? spyRows
        : await history(ticker, window.start, window.until);
    run.add(ticker, rows, ticker === benchmark ? [] : await daily(ticker));
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
const result = run.finish();
writeFileSync(out, JSON.stringify(result));

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
