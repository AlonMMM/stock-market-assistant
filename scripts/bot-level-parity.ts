// Checks the bot's failed-break watch (packages/trading/src/bot/levels.ts)
// against the Python backtest: for every champion trade the level ahead at the
// signal and what the stock did at it over the entry day (break, failed
// break, the end of the watch, and the minute) must be the backtest's.
//
//   node --import tsx scripts/bot-level-parity.ts <market.sqlite> <level_parity.csv>
//
// The CSV comes from scripts/research/indi_bt/level_parity_export.py (branch
// research/indi-v2). Reads the backtest's local cache (data/local/x/bt, not in Git).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { MinuteBar } from "../packages/trading/src/bot/signal.js";
import {
  advanceWatch,
  priorLevels,
  watchFor,
} from "../packages/trading/src/bot/levels.js";

const [dbPath, csvPath] = process.argv.slice(2);
if (!dbPath || !csvPath)
  throw new Error(
    "usage: bot-level-parity.ts <market.sqlite> <level_parity.csv>",
  );
const db = new DatabaseSync(dbPath, { readOnly: true });
const read = db.prepare("SELECT bars FROM bars WHERE symbol = ? AND date = ?");
const day = (symbol: string, date: string): MinuteBar[] => {
  const row = read.get(symbol, date) as { bars: string } | undefined;
  return (row ? (JSON.parse(row.bars) as number[][]) : []).map(
    ([m, o, h, l, c, v]) => ({ m: m!, o: o!, h: h!, l: l!, c: c!, v: v! }),
  );
};
const calendar = (
  db
    .prepare("SELECT date FROM bars WHERE symbol = 'SPY' ORDER BY date")
    .all() as { date: string }[]
).map((r) => r.date);

// The backtest's level names, in the bot's words.
const names: Record<string, string> = {
  "yesterday high": "yesterday's high",
  "yesterday low": "yesterday's low",
  "5-day high": "the 5-day high",
  "5-day low": "the 5-day low",
  "day high so far": "the day's high",
  "day low so far": "the day's low",
  "15-min high": "the 15-minute high",
  "15-min low": "the 15-minute low",
};

const [head, ...lines] = readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
const cols = head!.split(",");
let same = 0;
const diffs: string[] = [];
for (const line of lines) {
  const r = Object.fromEntries(line.split(",").map((v, i) => [cols[i], v]));
  const i = calendar.indexOf(r.date!);
  const today = day(r.sym!, r.date!);
  const m0 = Number(r.minute);
  const prior = priorLevels(
    calendar.slice(i - 5, i).map((d) => day(r.sym!, d)),
  );
  const at = today.find((b) => b.m === m0);
  const right = r.right as "C" | "P";
  let w = at ? watchFor(prior, today, m0, at.c, right) : null;
  if (w) w = advanceWatch(w, today, 379, right);
  const got = w
    ? `${w.name} ${w.level.toFixed(4)} ${w.state} ${w.at ?? ""}`
    : "none";
  const want =
    r.state === "none"
      ? "none"
      : `${names[r.name!]} ${Number(r.level).toFixed(4)} ${r.state} ${r.at}`;
  if (got === want) same++;
  else
    diffs.push(
      `${r.date} ${r.sym} ${right} ${m0}: bot ${got} | backtest ${want}`,
    );
}
console.log(`${same} of ${lines.length} trades the same`);
for (const d of diffs.slice(0, 20)) console.log(d);
if (diffs.length) process.exitCode = 1;
