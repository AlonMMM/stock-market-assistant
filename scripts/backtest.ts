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
// Results are cached in the cloud (D1, shared with the site) through
// ResultCache (packages/market-data/src/result-cache.ts): each symbol's computed
// part in backtest_parts and each complete run in backtest_runs, keyed by a
// SHA-256 over the rule version, the evaluation code version, the dates,
// settings and symbols. data/local/bars-cache.sqlite keeps a local copy, so
// reruns do not download them again. A rerun computes only uncached symbols,
// then ranks look-now scores across all. Ranges whose last day is not final and
// runs with failed symbols are not cached.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ruleVersion } from "../packages/alerts/src/relative-volume.js";
import { AlpacaFeed } from "../packages/market-data/src/alpaca.js";
import {
  backtestWindow,
  BacktestInputError,
  BacktestRun,
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
import { codeVersion } from "../packages/market-data/src/code-version.js";
import {
  ResultCache,
  runKey,
} from "../packages/market-data/src/result-cache.js";
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

// D1 through wrangler: bound values are inlined as SQL literals. Reads and
// single statements run at once; batches are buffered and applied as SQL files
// (flushRemote), since each wrangler call takes seconds.
const quote = (v: unknown) =>
  typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`;
const d1 = (...args: string[]) =>
  execFileSync(
    wrangler,
    ["d1", "execute", "sma-bars-cache", "--remote", "--json", ...args],
    { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
let pending: string[] = [];
let pendingChars = 0;
function flushRemote() {
  if (!pending.length) return;
  const dir = mkdtempSync(join(tmpdir(), "sma-results-"));
  try {
    writeFileSync(join(dir, "results.sql"), pending.join("\n"));
    for (let attempt = 1; ; attempt++)
      try {
        d1("--yes", "--file", join(dir, "results.sql"));
        break;
      } catch (error) {
        // Rows are content-addressed, so a retry rewrites the same values.
        if (attempt === 3) throw error;
        console.error(`D1 result upload attempt ${attempt} failed; retrying`);
      }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  pending = [];
  pendingChars = 0;
}
const remoteD1: D1Like = {
  prepare(sql: string) {
    const inline = (params: unknown[]) => {
      let i = 0;
      return sql.replace(/\?/g, () => quote(params[i++]));
    };
    const statement = (params: unknown[]): D1Statement & { sql: string } => ({
      sql: inline(params),
      bind: (...values) => statement(values),
      all: async <T>() => {
        const text = d1("--command", inline(params));
        return {
          results: JSON.parse(text.slice(text.indexOf("[")))[0].results as T[],
        };
      },
      run: async () => d1("--command", inline(params)),
    });
    return statement([]);
  },
  async batch(statements) {
    for (const s of statements as (D1Statement & { sql: string })[]) {
      pending.push(`${s.sql};`);
      pendingChars += s.sql.length;
    }
    if (pendingChars > 50_000_000) flushRemote();
  },
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
// Result caches: the local copy first, then D1 (see the header).
const code = codeVersion(root);
const localResults = new ResultCache(
  new SqliteD1(`${root}data/local/bars-cache.sqlite`),
  code,
);
const cloudResults = new ResultCache(remoteD1, code);
const useCache = args.get("no-cache") === undefined && window.complete;
if (!window.complete) console.warn("The last day is not final: not cached.");
const thisRun = await runKey(code, request, window);
const failed: string[] = [];
let result: BacktestResult | undefined;
if (useCache) {
  let text = (await localResults.runs.get([thisRun])).get(thisRun);
  text ??= (await cloudResults.runs.get([thisRun])).get(thisRun);
  if (text) {
    console.log(`Rule ${ruleVersion}: identical run found in backtest_runs`);
    result = JSON.parse(text) as BacktestResult;
  }
}
if (!result) {
  result = await computeRun();
  // A run with failed symbols is incomplete: never served as cached.
  if (useCache && !failed.length) {
    const entry = {
      key: thisRun,
      meta: {
        rule: ruleVersion,
        from_date: from,
        to_date: to,
        symbols: JSON.stringify(request.tickers),
        settings: JSON.stringify({
          config: request.config,
          validation: request.validation,
        }),
        summary: JSON.stringify({
          alerts: result.alerts.length,
          evaluated: result.evaluated,
          lookNow: result.lookNow,
          validation: { ...result.validation, baselineBySymbol: undefined },
          diagnostics: result.diagnostics,
        }),
      },
      text: JSON.stringify(result),
    };
    await localResults.runs.put([entry]);
    await cloudResults.runs.put([entry]);
  }
}
flushRemote();
writeFileSync(out, JSON.stringify(result));

async function computeRun() {
  const keys = new Map<string, string>();
  for (const t of request.tickers)
    keys.set(t, await localResults.partKey(request, window, t));
  // Cached parts, read in groups to keep memory and wrangler output small.
  const groups: string[][] = [];
  for (let i = 0; i < request.tickers.length; i += 10)
    groups.push(request.tickers.slice(i, i + 10));
  const hits = new Set<string>();
  if (useCache)
    for (const group of groups) {
      const wanted = group.map((t) => keys.get(t)!);
      const local = await localResults.parts.get(wanted);
      for (const k of wanted) if (local.has(k)) hits.add(k);
      const missing = wanted.filter((k) => !local.has(k));
      if (!missing.length) continue;
      // Copy cloud parts into the local file; they are merged below.
      const cloud = await cloudResults.parts.get(missing);
      const tickerOf = new Map(group.map((t) => [keys.get(t)!, t]));
      await localResults.parts.put(
        [...cloud].map(([key, text]) => ({
          key,
          meta: { rule: ruleVersion, ticker: tickerOf.get(key)! },
          text,
        })),
      );
      for (const k of cloud.keys()) hits.add(k);
    }
  console.log(
    `Rule ${ruleVersion}, code ${code}: ${hits.size} of ${request.tickers.length} symbols cached`,
  );
  // SPY's bars are only needed to compute uncached symbols.
  const needed = hits.size < request.tickers.length;
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
    const key = keys.get(ticker)!;
    try {
      if (hits.has(key)) {
        const part = (await localResults.getParts([key])).get(key);
        // Listed as cached above; SPY was not loaded for it, so it must exist.
        if (!part) throw new Error("cached part removed during the run; rerun");
        run.merge(part);
        continue;
      }
      const rows =
        ticker === benchmark
          ? spyRows
          : await history(ticker, window.start, window.until);
      const part = run.compute(
        ticker,
        rows,
        ticker === benchmark ? [] : await daily(ticker),
      );
      if (useCache) {
        await localResults.putParts([{ key, part }]);
        await cloudResults.putParts([{ key, part }]);
      }
      run.merge(part);
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
