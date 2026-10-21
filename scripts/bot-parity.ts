// Checks the bot's TypeScript signal against the Python backtest it was ported
// from: every stock-day of a signal file from scripts/research/indi_bt/
// (t_sig_tiers_<year>.csv) must get the same first minute and side.
//
//   node --import tsx scripts/bot-parity.ts <market.sqlite> <t_sig_tiers_YYYY.csv> [YYYY-MM-DD from] [to]
//
// Reads the backtest's local bar cache (data/local/x/bt, not in Git).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  cSignal,
  priorFrom,
  type MinuteBar,
} from "../packages/trading/src/bot/signal.js";

const [dbPath, csvPath, from = "0000", to = "9999"] = process.argv.slice(2);
if (!dbPath || !csvPath)
  throw new Error(
    "usage: bot-parity.ts <market.sqlite> <signals.csv> [from] [to]",
  );

const db = new DatabaseSync(dbPath, { readOnly: true });
const read = db.prepare("SELECT bars FROM bars WHERE symbol = ? AND date = ?");
const cache = new Map<string, MinuteBar[]>();
function day(symbol: string, date: string): MinuteBar[] {
  const key = `${symbol}|${date}`;
  let bars = cache.get(key);
  if (!bars) {
    const row = read.get(symbol, date) as { bars: string } | undefined;
    const raw = row ? (JSON.parse(row.bars) as number[][]) : [];
    bars = raw.map(([m, o, h, l, c, v]) => ({
      m: m!,
      o: o!,
      h: h!,
      l: l!,
      c: c!,
      v: v!,
    }));
    cache.set(key, bars);
  }
  return bars;
}
const calendar = (
  db
    .prepare("SELECT date FROM bars WHERE symbol = 'SPY' ORDER BY date")
    .all() as { date: string }[]
).map((r) => r.date);

const lines = readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
const head = lines[0]!.split(",");
const col = (name: string) => head.indexOf(name);
const expected = new Map<string, { minute: number; right: string }>();
for (const line of lines.slice(1)) {
  const f = line.split(",");
  expected.set(`${f[col("date")]}|${f[col("sym")]}`, {
    minute: Number(f[col("minute")]),
    right: f[col("right")]!,
  });
}
const symbols = [...new Set([...expected.keys()].map((k) => k.split("|")[1]!))];
const dates = [
  ...new Set([...expected.keys()].map((k) => k.split("|")[0]!)),
].sort();
const first = dates[0]!,
  lastDate = dates.at(-1)!;

let same = 0,
  differ = 0;
const examples: string[] = [];
for (let i = 1; i < calendar.length; i++) {
  const date = calendar[i]!;
  if (date < first || date > lastDate || date < from || date > to) continue;
  const spy = day("SPY", date);
  for (const symbol of symbols) {
    const bars = day(symbol, date);
    if (bars.length <= 300) continue; // the backtest skipped days with gaps
    const prior = priorFrom(
      calendar
        .slice(Math.max(0, i - 20), i)
        .map((d) => ({ stock: day(symbol, d), spy: day("SPY", d) })),
    );
    const got = cSignal(bars, spy, prior);
    const want = expected.get(`${date}|${symbol}`);
    const ok =
      got === null
        ? !want
        : !!want && want.minute === got.minute && want.right === got.right;
    if (ok) same++;
    else {
      differ++;
      if (examples.length < 15)
        examples.push(
          `${date} ${symbol}: python ${want ? `${want.right}@${want.minute}` : "none"}, ts ${got ? `${got.right}@${got.minute}` : "none"}`,
        );
    }
  }
  if (date.endsWith("-01")) console.log(date, same, differ);
}
console.log(`stock-days that agree: ${same}, differ: ${differ}`);
for (const e of examples) console.log(e);
