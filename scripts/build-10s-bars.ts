// Builds a local SQLite database of 10-second bars, regular hours only, for the
// research symbol list, from Alpaca SIP trades (Alpaca serves no bars under a
// minute). Every trade of a symbol-day is fetched and aggregated with Alpaca's
// own condition rules (packages/market-data/src/trade-bars.ts), so a minute
// rolled up from these bars matches Alpaca's minute bar.
//
// Resumable: a symbol-day is written in one transaction and recorded in
// `symbol_days`; rerunning skips recorded days, so a stopped run continues
// where it was and a daily rerun appends the latest session.
//
//   node --env-file=.env --import tsx scripts/build-10s-bars.ts [options]
// Options:
//   --months 12             history to build, counted back from today (1–36)
//   --from / --to           explicit New York dates instead of --months
//   --tickers <path>        symbol file, one per line (default data/local/backtest-tickers.txt)
//   --symbols A,B,C         instead of the file
//   --db <path>             database (default data/local/bars-10s.sqlite)
//   --rate 1000             max Alpaca requests per minute (Algo Trader Plus allows 10,000)
//   --parallel 4            symbols fetched at the same time
//   --seconds 10            bar size; a database keeps the size it was created with
// Credentials: ALPACA_API_KEY / ALPACA_API_SECRET (real-time SIP; set
// ALPACA_SIP_DELAY_MINUTES without it).
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { AlpacaFeed } from "../packages/market-data/src/alpaca.js";
import {
  coreClose,
  newYork,
  newYorkToUtc,
} from "../packages/market-data/src/calendar.js";
import {
  parseSipDelay,
  sipDelayMs,
} from "../packages/market-data/src/sip-delay.js";
import {
  TradeBarBuilder,
  type Trade,
} from "../packages/market-data/src/trade-bars.js";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const [flag, value] = [process.argv[i]!, process.argv[i + 1]];
  if (flag.startsWith("--") && value !== undefined) {
    args.set(flag.slice(2), value);
    i++;
  } else throw new Error(`Unexpected argument ${flag}`);
}
const months = Number(args.get("months") ?? 12);
const rate = Number(args.get("rate") ?? 1000);
const parallel = Number(args.get("parallel") ?? 4);
const barSeconds = Number(args.get("seconds") ?? 10);
const dbPath = args.get("db") ?? "data/local/bars-10s.sqlite";
const tickersPath = args.get("tickers") ?? "data/local/backtest-tickers.txt";
if (!(months >= 1 && months <= 36)) throw new Error("--months must be 1–36");
if (!(rate >= 1 && rate <= 10000)) throw new Error("--rate must be 1–10000");
if (!(parallel >= 1 && parallel <= 32))
  throw new Error("--parallel must be 1–32");
if (!Number.isInteger(barSeconds) || barSeconds < 1 || 60 % barSeconds !== 0)
  throw new Error("--seconds must divide 60");
const key = process.env.ALPACA_API_KEY;
const secret = process.env.ALPACA_API_SECRET;
if (!key || !secret)
  throw new Error("Set ALPACA_API_KEY and ALPACA_API_SECRET");

// Symbols: the file (one per line, # comments) or --symbols.
const symbols = [
  ...new Set(
    (args.get("symbols")
      ? args.get("symbols")!.split(",")
      : readFileSync(tickersPath, "utf8").split("\n")
    )
      .map((s) => s.replace(/#.*/, "").trim().toUpperCase())
      .filter(Boolean),
  ),
].sort();
if (!symbols.length) throw new Error("No symbols");

// Trading days with final data: a day is final once its close is past the
// SIP delay. Days are New York dates.
const readyBefore =
  Date.now() - sipDelayMs(parseSipDelay(process.env.ALPACA_SIP_DELAY_MINUTES));
const today = newYork(readyBefore).date;
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const defaultFrom = (() => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
})();
const from = args.get("from") ?? defaultFrom;
const to = args.get("to") ?? today;
if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
  throw new Error("--from and --to are YYYY-MM-DD");
interface Session {
  date: string;
  startMs: number; // 09:30 New York
  endMs: number; // the core close, 16:00 or 13:00
}
const sessions: Session[] = [];
for (let date = from; date <= to; date = addDays(date, 1)) {
  const closeMinute = coreClose(date);
  if (closeMinute === null) continue;
  const session = {
    date,
    startMs: newYorkToUtc(date, 570),
    endMs: newYorkToUtc(date, closeMinute),
  };
  if (session.endMs <= readyBefore) sessions.push(session);
}
if (!sessions.length) throw new Error("No finished sessions in the range");

// Paced, retrying fetch shared by every worker: `rate` requests per minute in
// all, with 429 and 5xx answers retried after a pause.
let nextSlot = 0;
let requests = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const paced = (async (input: URL | RequestInfo, init?: RequestInit) => {
  for (let attempt = 1; ; attempt++) {
    const wait = nextSlot - Date.now();
    nextSlot = Math.max(Date.now(), nextSlot) + 60000 / rate;
    if (wait > 0) await sleep(wait);
    requests++;
    let response: Response | undefined;
    let failure: unknown;
    try {
      response = await fetch(input, init);
    } catch (error) {
      failure = error; // network error or timeout: retry like a 5xx
    }
    const retry =
      response === undefined ||
      response.status === 429 ||
      response.status >= 500;
    if (!retry || attempt >= 5) {
      if (response) return response;
      throw failure;
    }
    const pause = response?.status === 429 ? 15000 : 3000 * attempt;
    nextSlot = Math.max(nextSlot, Date.now() + pause);
    await sleep(pause);
  }
}) as typeof fetch;
const feed = new AlpacaFeed(key, secret, "sip", () => {}, paced);

// Storage. Prices are REAL dollars, start is Unix seconds (bar start), volume
// is shares. `symbol_days` records finished symbol-days, including ones with
// no trades, so they are not fetched again.
mkdirSync(dirname(dbPath), { recursive: true });
const fresh = !existsSync(dbPath);
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bars (
    symbol TEXT NOT NULL,
    start INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume INTEGER NOT NULL,
    trades INTEGER NOT NULL,
    vwap REAL NOT NULL,
    PRIMARY KEY (symbol, start)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS symbol_days (
    symbol TEXT NOT NULL,
    date TEXT NOT NULL,
    trades INTEGER NOT NULL,
    bars INTEGER NOT NULL,
    built_at INTEGER NOT NULL,
    PRIMARY KEY (symbol, date)
  );
`);
const meta = new Map(
  (
    db.prepare("SELECT key, value FROM meta").all() as {
      key: string;
      value: string;
    }[]
  ).map((r) => [r.key, r.value]),
);
if (fresh || !meta.has("bar_seconds")) {
  const put = db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
  );
  put.run("bar_seconds", String(barSeconds));
  put.run("feed", "sip");
  put.run("hours", "regular");
  put.run("rules", "alpaca-market-data-faq-2026-10-23");
  put.run("source", "scripts/build-10s-bars.ts");
} else if (Number(meta.get("bar_seconds")) !== barSeconds)
  throw new Error(
    `${dbPath} holds ${meta.get("bar_seconds")}-second bars; use --seconds ${meta.get("bar_seconds")} or another --db`,
  );

const done = new Set(
  (
    db
      .prepare(
        "SELECT symbol, date FROM symbol_days WHERE date >= ? AND date <= ?",
      )
      .all(from, to) as { symbol: string; date: string }[]
  ).map((r) => `${r.symbol}|${r.date}`),
);
const insertBar = db.prepare(
  "INSERT OR REPLACE INTO bars (symbol, start, open, high, low, close, volume, trades, vwap) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
const insertDay = db.prepare(
  "INSERT OR REPLACE INTO symbol_days (symbol, date, trades, bars, built_at) VALUES (?, ?, ?, ?, ?)",
);

const toTrade = (t: {
  t: string;
  p: number;
  s: number;
  c?: string[] | null;
  z?: string;
  u?: string;
}): Trade => ({
  time: Date.parse(t.t), // nanoseconds are truncated to the millisecond
  price: t.p,
  size: t.s,
  conditions: t.c ?? [],
  tape: t.z ?? "",
  ...(t.u ? { correction: t.u } : {}),
});

async function buildDay(symbol: string, session: Session) {
  const builder = new TradeBarBuilder(
    barSeconds,
    session.startMs,
    session.endMs,
  );
  let trades = 0;
  for await (const page of feed.trades(
    symbol,
    new Date(session.startMs).toISOString(),
    new Date(session.endMs).toISOString(),
  )) {
    trades += page.length;
    for (const trade of page) {
      if (!Number.isFinite(Date.parse(trade.t)))
        throw new Error(`Invalid trade time ${trade.t}`);
      builder.add(toTrade(trade));
    }
  }
  const bars = builder.bars();
  db.exec("BEGIN");
  try {
    for (const b of bars)
      insertBar.run(
        symbol,
        b.start,
        b.open,
        b.high,
        b.low,
        b.close,
        b.volume,
        b.trades,
        b.vwap,
      );
    insertDay.run(symbol, session.date, trades, bars.length, Date.now());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { trades, bars: bars.length };
}

const totals = { days: 0, skipped: 0, trades: 0, bars: 0 };
const failed: string[] = [];
const began = Date.now();
const pending = sessions.length * symbols.length - done.size;
console.log(
  `Building ${barSeconds}-second bars for ${symbols.length} symbols, ` +
    `${sessions[0]!.date} → ${sessions.at(-1)!.date} (${sessions.length} sessions), ` +
    `${pending} symbol-days to fetch, ≤ ${rate} requests/min, ${parallel} in parallel → ${dbPath}`,
);
const progress = setInterval(() => {
  const seconds = Math.round((Date.now() - began) / 1000);
  const perMinute = totals.days / Math.max(seconds / 60, 1 / 60);
  const left = Math.round((pending - totals.days) / Math.max(perMinute, 0.01));
  console.log(
    `… ${totals.days}/${pending} symbol-days, ${totals.trades.toLocaleString()} trades, ` +
      `${requests} requests, ${seconds} s elapsed, ~${left} min left`,
  );
}, 30000);

const queue = [...symbols];
async function worker() {
  for (let symbol = queue.shift(); symbol; symbol = queue.shift()) {
    const started = Date.now();
    const count = { days: 0, trades: 0, bars: 0, failed: 0 };
    for (const session of sessions) {
      if (done.has(`${symbol}|${session.date}`)) {
        totals.skipped++;
        continue;
      }
      try {
        const result = await buildDay(symbol, session);
        count.days++;
        count.trades += result.trades;
        count.bars += result.bars;
        totals.days++;
        totals.trades += result.trades;
        totals.bars += result.bars;
      } catch (error) {
        count.failed++;
        failed.push(`${symbol} ${session.date}`);
        console.error(
          `${symbol} ${session.date}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    console.log(
      `${symbol}: ${count.days} days, ${count.trades.toLocaleString()} trades → ` +
        `${count.bars.toLocaleString()} bars` +
        (count.failed ? `, ${count.failed} failed` : "") +
        ` · ${Math.round((Date.now() - started) / 1000)} s`,
    );
  }
}
try {
  await Promise.all(Array.from({ length: parallel }, worker));
} finally {
  clearInterval(progress);
  db.close();
}
console.log(
  `Done: ${totals.days} symbol-days built (${totals.bars.toLocaleString()} bars from ` +
    `${totals.trades.toLocaleString()} trades), ${totals.skipped} already there, ` +
    `${requests} Alpaca requests in ${Math.round((Date.now() - began) / 1000)} s.`,
);
if (failed.length) {
  console.error(`Not built (rerun to retry): ${failed.length} symbol-days`);
  process.exitCode = 1;
}
