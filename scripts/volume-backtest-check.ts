// The Volume bot's backtest (packages/trading/src/strangle/backtest.ts) against
// the research simulator that produced the live numbers (the user,
// 2026-10-31: "lets open the volume for backtesting on the app"): the same
// 3 years and stocks, read from the research's own caches on the Mac, so a
// gap is the engine's, not the data's. The research's production row
// (volume-bot.md, "No floor, fixed (chase to ask)", flat2 2%): 467 trades,
// +35.7% a trade, $100K -> $1,011,767, worst drop 22.2%; with the live bot's
// 200-contract floor: 430 trades, $782,861.
//
//   node --import tsx scripts/volume-backtest-check.ts <research.json> [options]
//
// research.json: the research's alerts and news verdicts (news_dump.py in the
// session scratchpad). Options:
//   --alerts research|computed  the research's alert lists (default), or the engine's own
//   --books seconds|minutes     the 1-second books the research read (default), or the minute books only (the app)
//   --floor N                   the liquidity floor (default 0, the research's production row; 200 = live)
//   --from / --to               the dates (default the research's 2024-02-01 .. 2026-10-22)
//   --compare FILE              the research's kept trades (STR_DUMP_DIR), trade by trade
//   --out FILE                  the engine's signals, as JSON
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { backtestCalendar } from "../packages/market-data/src/bot-backtest.js";
import {
  occSymbol,
  type ChainContract,
  type QuoteMinute,
} from "../packages/trading/src/bot/backtest.js";
import type { MinuteBar } from "../packages/trading/src/bot/signal.js";
import {
  runVolumeStock,
  tradeReturn,
  volumeAccount,
  type SecondBook,
  type VolumeBacktestData,
  type VolumeSignal,
  type VolumeStockRun,
} from "../packages/trading/src/strangle/backtest.js";
import { defaultStrangleSettings } from "../packages/trading/src/strangle/settings.js";

const MAIN = "/Users/alonmo/Desktop/Personal/stock-market-assistant";
const RESEARCH =
  "/Users/alonmo/Desktop/Personal/sma-indi-backtest/scripts/research/indi_bt";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
const researchFile = args[0]!;
const alertSource = opt("alerts", "research");
const books = opt("books", "seconds");
const floor = Number(opt("floor", "0"));
const from = opt("from", "2024-02-01");
const to = opt("to", "2026-10-22");
const compareFile = opt("compare", "");
const outFile = opt("out", "");

interface ResearchAlert {
  tag: string;
  date: string;
  sym: string;
  kind: "plan" | "shock";
  second: number;
  price: number;
  m: number;
}
const research = JSON.parse(readFileSync(researchFile, "utf8")) as {
  alerts: ResearchAlert[];
  news: Record<string, "earnings" | "premarket">;
};
const alertsBy = new Map<string, ResearchAlert[]>();
for (const a of research.alerts) {
  const key = `${a.sym}|${a.date}`;
  let list = alertsBy.get(key);
  if (!list) alertsBy.set(key, (list = []));
  list.push(a);
}
const symbols = [...new Set(research.alerts.map((a) => a.sym))].sort();

// ---- the research's caches ----

const market = new DatabaseSync(`${MAIN}/data/local/x/bt/market.sqlite`, {
  readOnly: true,
});
const barsQuery = market.prepare(
  "SELECT bars FROM bars WHERE symbol = ? AND date = ?",
);
const strikesQuery = market.prepare(
  "SELECT strikes FROM chain WHERE und = ? AND expiry = ? AND right = ?",
);
const expiryQuery = market.prepare(
  "SELECT strikes FROM chain WHERE und = ? AND right = 'X'",
);

const barCache = new Map<string, MinuteBar[]>();
function readBars(symbol: string, date: string): MinuteBar[] {
  const key = `${symbol}|${date}`;
  let got = barCache.get(key);
  if (got) return got;
  const row = barsQuery.get(symbol, date) as { bars: string } | undefined;
  got = row
    ? (JSON.parse(row.bars) as number[][])
        .filter((b) => b[0]! >= 0 && b[0]! < 390)
        .map(([m, o, h, l, c, v]) => ({
          m: m!,
          o: o!,
          h: h!,
          l: l!,
          c: c!,
          v: v!,
        }))
    : [];
  barCache.set(key, got);
  return got;
}

const expiries = new Map<string, string[]>();
function expiryList(symbol: string): string[] {
  let got = expiries.get(symbol);
  if (got) return got;
  const all = new Set<string>();
  for (const r of expiryQuery.all(symbol) as { strikes: string }[])
    for (const e of JSON.parse(r.strikes) as string[]) all.add(e);
  got = [...all].sort();
  expiries.set(symbol, got);
  return got;
}

let quoteDate = "";
let quoteDay = new Map<string, QuoteMinute[]>();
function quotesOf(date: string): Map<string, QuoteMinute[]> {
  if (date === quoteDate) return quoteDay;
  quoteDate = date;
  quoteDay = new Map();
  for (const path of [
    `${RESEARCH}/dbx_cache/${date}.csv.gz`,
    `${RESEARCH}/dbx_cache/extra/${date}.csv.gz`,
  ]) {
    if (!existsSync(path)) continue;
    const lines = gunzipSync(readFileSync(path)).toString().split("\n");
    const head = lines[0]!.split(",");
    const at = (k: string) => head.indexOf(k);
    const [ci, mi, bi, ai] = [
      at("contract"),
      at("minute"),
      at("bid"),
      at("ask"),
    ];
    for (const line of lines.slice(1)) {
      if (!line) continue;
      const f = line.split(",");
      if (!f[bi] || !f[ai] || !(Number(f[ai]) > 0)) continue;
      let list = quoteDay.get(f[ci]!);
      if (!list) quoteDay.set(f[ci]!, (list = []));
      // The cache's row m is the book as minute m began: as minute m - 1 closed.
      list.push({
        m: Number(f[mi]) - 1,
        bid: Number(f[bi]),
        ask: Number(f[ai]),
      });
    }
  }
  for (const list of quoteDay.values()) list.sort((a, b) => a.m - b.m);
  return quoteDay;
}

function csvRows(path: string): string[][] {
  if (!existsSync(path)) return [];
  return gunzipSync(readFileSync(path))
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(","));
}

const data: VolumeBacktestData = {
  lastSession: to,
  bars: readBars,
  premarket: () => null,
  earnings: async () => [],
  async chain(symbol, right, lo, hi) {
    const out: ChainContract[] = [];
    const r = right === "call" ? "C" : "P";
    for (const expiry of expiryList(symbol)) {
      if (expiry < lo || expiry > hi) continue;
      const row = strikesQuery.get(symbol, expiry, r) as
        { strikes: string } | undefined;
      const strikes = row ? (JSON.parse(row.strikes) as number[]) : [];
      // An expiry the research listed but never read strikes for still counts as one.
      if (!strikes.length) out.push({ symbol: "", expiry, strike: NaN });
      for (const k of strikes)
        out.push({
          symbol: occSymbol(symbol, expiry, r, k),
          expiry,
          strike: k,
        });
    }
    return out;
  },
  async optionDay(contracts, date) {
    return new Map(contracts.map((c) => [c, readBars(c, date)]));
  },
  async optionQuotes(contract, lo) {
    return new Map([[lo, quotesOf(lo).get(contract) ?? []]]);
  },
  async stockSeconds(symbol, date, lo, hi) {
    // leg_seconds.py's files: a shock alert's by its second, a minute alert's by its minute.
    let rows = csvRows(
      `${RESEARCH}/sec_cache/stock/${date}_${symbol}_s${lo}.csv.gz`,
    );
    if (!rows.length && lo % 60 === 0)
      rows = csvRows(
        `${RESEARCH}/sec_cache/stock/${date}_${symbol}_${lo / 60 - 1}.csv.gz`,
      );
    return rows
      .map(([s, c]) => [Number(s), Number(c)] as [number, number])
      .filter(([s]) => s >= lo && s <= hi);
  },
  // The engine's own alerts (--alerts computed) still take the research's shock list.
  async shockAlerts(symbol, lo, hi) {
    return research.alerts
      .filter(
        (a) =>
          a.kind === "shock" &&
          a.sym === symbol &&
          a.date >= lo &&
          a.date <= hi,
      )
      .map((a) => ({
        date: a.date,
        second: a.second,
        price: a.price,
        up: true,
      }));
  },
};
if (books === "seconds")
  data.optionSeconds = async (contract, date, lo) => {
    // Keyed by the side's second: the engine asks from 2 s before it.
    const rows = csvRows(
      `${RESEARCH}/sec_cache/opt/${date}_${contract}_${lo + 2}.csv.gz`,
    );
    return rows.map(([s, b, a]): SecondBook => ({
      s: Number(s),
      bid: Number(b),
      ask: Number(a),
    }));
  };

// ---- the run ----

const settings = {
  ...defaultStrangleSettings,
  delta: 0.2,
  minVolume: floor,
  shockAlert: true,
  fastAlert: false,
};
const sessions: string[] = [];
for (let d = to; d >= from; d = backtestCalendar.previousSessions(d, 1)[0]!)
  if (backtestCalendar.sessionLength(d) !== null) sessions.unshift(d);
const runs = new Map<string, VolumeStockRun>(
  symbols.map((s) => [s, { symbol: s, signals: [], ignored: [] }]),
);
const t0 = Date.now();
for (const [i, date] of sessions.entries()) {
  for (const symbol of symbols) {
    if (alertSource === "research" && !alertsBy.has(`${symbol}|${date}`))
      continue;
    const run = await runVolumeStock(
      symbol,
      [date],
      settings,
      data,
      backtestCalendar,
      {
        fillPct: 2,
        strictQuotes: books === "seconds",
        ...(alertSource === "research"
          ? {
              alerts: (s: string, d: string) =>
                (alertsBy.get(`${s}|${d}`) ?? []).map((a) => ({
                  kind: a.kind,
                  second: a.second,
                  price: a.price,
                  up: true,
                })),
            }
          : {}),
        news: (s, d) => {
          const why = research.news[`${d}|${s}`];
          return why ? { reason: why, detail: "" } : null;
        },
      },
    );
    runs.get(symbol)!.signals.push(...run.signals);
  }
  // Keep the bar cache to the sessions the next days still read.
  if (i % 20 === 19)
    for (const key of barCache.keys())
      if (key.split("|")[1]! < backtestCalendar.previousSessions(date, 25)[0]!)
        barCache.delete(key);
  if (i % 50 === 0)
    console.error(
      `${date}: ${i + 1}/${sessions.length} (${Math.round((Date.now() - t0) / 1000)} s)`,
    );
}
const all = [...runs.values()];
const signals = all.flatMap((r) => r.signals);
if (outFile) writeFileSync(outFile, JSON.stringify(signals));

const outcomes = new Map<string, number>();
for (const s of signals)
  outcomes.set(s.outcome, (outcomes.get(s.outcome) ?? 0) + 1);
console.log(
  `\n${signals.length} alerts (${alertSource}); books ${books}; floor ${floor}; ${from} .. ${to}`,
);
console.log(
  "outcomes:",
  Object.fromEntries([...outcomes].sort((a, b) => b[1] - a[1])),
);

const money = {
  start: 100_000,
  sizePct: 2,
  feePerContract: 0.62,
  maxPerStock: 2,
  maxTradesPerDay: 15,
  maxOpen: 5,
  dayLossPct: 7.5,
};
for (const [label, limits] of [
  ["flat2 (no limits)", false],
  ["live2 (live limits)", true],
] as const) {
  const a = volumeAccount(all, { ...money, limits });
  console.log(
    `| ${label} | ${a.taken} trades | ${a.won} won | ${(a.avgRet * 100).toFixed(1)}% a trade | $${Math.round(a.end).toLocaleString("en-US")} | drop ${a.maxDrawdownPct.toFixed(1)}% |`,
  );
}

// ---- trade by trade against the research's kept trades ----

// ---- the engine's own plan alerts against the research's lists ----

if (alertSource === "computed") {
  // The research listed alerts only on days with an expiry it trades, and each
  // list to its own last day: compare on the days and stocks it covered.
  const covered = new Map<string, string>();
  for (const a of research.alerts)
    if (a.kind === "plan" && (covered.get(a.sym) ?? "") < a.date)
      covered.set(a.sym, a.date);
  const theirs = new Set(
    research.alerts
      .filter((a) => a.kind === "plan" && a.date >= from && a.date <= to)
      .map((a) => `${a.date}|${a.sym}|${a.m}`),
  );
  const ours = new Set(
    signals
      .filter(
        (s) =>
          s.kind === "plan" &&
          s.outcome !== "no_expiry" &&
          s.date <= (covered.get(s.symbol) ?? ""),
      )
      .map((s) => `${s.date}|${s.symbol}|${s.minute}`),
  );
  const both = [...ours].filter((k) => theirs.has(k)).length;
  const onlyOurs = [...ours].filter((k) => !theirs.has(k));
  const onlyTheirs = [...theirs].filter((k) => !ours.has(k));
  console.log(
    `\nplan alerts: research ${theirs.size}, engine ${ours.size}, both ${both}; engine only ${onlyOurs.length} (${onlyOurs.slice(0, 8).join(", ")}); research only ${onlyTheirs.length} (${onlyTheirs.slice(0, 8).join(", ")})`,
  );
}

if (compareFile) {
  interface Kept {
    date: string;
    sym: string;
    minute: number;
    src: string;
    contract: string;
    buy: number;
    sell: number;
    ct: number;
    xm: number;
    pnl: number;
  }
  const kept = JSON.parse(readFileSync(compareFile, "utf8")) as Kept[];
  const flat = volumeAccount(all, { ...money, limits: false });
  const mine = new Map<string, VolumeSignal>();
  for (const x of flat.trades)
    if (x.status === "taken") {
      const kind = x.signal.kind;
      mine.set(
        `${x.signal.date}|${x.signal.symbol}|${kind}|${x.signal.minute}`,
        x.signal,
      );
    }
  const keyOf = (k: Kept) =>
    `${k.date}|${k.sym}|${k.src === "e_shock15" ? "shock" : "plan"}|${k.minute}`;
  let same = 0;
  let samePrice = 0;
  const onlyResearch: Kept[] = [];
  const differ: string[] = [];
  for (const k of kept) {
    const sig = mine.get(keyOf(k));
    if (!sig) {
      onlyResearch.push(k);
      continue;
    }
    mine.delete(keyOf(k));
    same++;
    const t = sig.trade!;
    const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    if (
      t.contract === k.contract &&
      close(t.buy, k.buy) &&
      close(t.sell, k.sell) &&
      t.exitMinute === k.xm
    )
      samePrice++;
    else
      differ.push(
        `${keyOf(k)}: research ${k.contract} ${k.buy.toFixed(2)} -> ${k.sell.toFixed(2)} @${k.xm}; engine ${t.contract} ${t.buy.toFixed(2)} -> ${t.sell.toFixed(2)} @${t.exitMinute}`,
      );
  }
  console.log(
    `\nresearch kept ${kept.length}; both ${same} (identical contract, prices and exit: ${samePrice}); research only ${onlyResearch.length}; engine only ${mine.size}`,
  );
  console.log("differ (first 15):\n  " + differ.slice(0, 15).join("\n  "));
  const why = (k: Kept) => {
    const sig = signals.find(
      (s) =>
        s.date === k.date &&
        s.symbol === k.sym &&
        s.minute === k.minute &&
        s.kind === (k.src === "e_shock15" ? "shock" : "plan"),
    );
    return sig
      ? `${sig.outcome}${sig.detail ? ` (${sig.detail})` : ""}`
      : "no alert";
  };
  console.log(
    "research only (first 15):\n  " +
      onlyResearch
        .slice(0, 15)
        .map((k) => `${keyOf(k)} ${k.contract}: ${why(k)}`)
        .join("\n  "),
  );
  console.log(
    "engine only (first 15):\n  " +
      [...mine.entries()]
        .slice(0, 15)
        .map(
          ([k, s]) =>
            `${k} ${s.trade!.contract} ${(tradeReturn(s.trade!, 0.62) * 100).toFixed(0)}%`,
        )
        .join("\n  "),
  );
}
