// The 60-second alert (packages/trading/src/strangle/fast.ts) against the
// backtest's alert file (indi_bt/f60_alerts.py output), on the local 10-second
// bars: every alert of the chosen stocks and dates, matched by stock, day and slot.
//
//   node --import tsx scripts/volume-fast-parity.ts <alerts.json> <from> <to> SYM,SYM [db]
//   RULE=shock: the shock alert (shockRule, 15x to 15:30) against the backtest's e_shock15 alerts
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { newYorkToUtc } from "../packages/market-data/src/calendar.js";
import {
  fastAlerts,
  fastBaseline,
  fastRule,
  fastWindows,
  shockRule,
  type FastDay,
} from "../packages/trading/src/strangle/fast.js";

const [file, from, to, list, dbPath = "data/local/bars-10s.sqlite"] =
  process.argv.slice(2);
if (!file || !from || !to || !list)
  throw new Error("usage: <alerts.json> <from> <to> SYM,SYM [db]");
const rule = process.env.RULE === "shock" ? shockRule : fastRule;
const db = new DatabaseSync(dbPath, { readOnly: true });
const want = JSON.parse(readFileSync(file, "utf8")) as {
  sym: string;
  date: string;
  slot: number;
}[];

/** One stock's session from the database, in 10-second slots. */
function dayOf(symbol: string, date: string): FastDay {
  const open = newYorkToUtc(date, 570) / 1000;
  const v: number[] = new Array(fastRule.slots).fill(0);
  const c: (number | null)[] = new Array(fastRule.slots).fill(null);
  const rows = db
    .prepare(
      "SELECT start, close, volume FROM bars WHERE symbol = ? AND start >= ? AND start < ?",
    )
    .all(symbol, open, open + fastRule.slots * 10) as {
    start: number;
    close: number;
    volume: number;
  }[];
  for (const r of rows) {
    const t = Math.floor((r.start - open) / 10);
    v[t] = r.volume;
    c[t] = r.close;
  }
  return { v, c };
}

let matched = 0;
let onlyTs = 0;
let onlyPy = 0;
for (const symbol of list.split(",")) {
  const days = (
    db
      .prepare(
        "SELECT date FROM symbol_days WHERE symbol = ? AND date <= ? ORDER BY date",
      )
      .all(symbol, to) as { date: string }[]
  ).map((r) => r.date);
  const windows = new Map<string, ReturnType<typeof fastWindows>>();
  const days2 = new Map<string, FastDay>();
  for (let i = 0; i < days.length; i++) {
    const d = days[i]!;
    if (
      d < from &&
      i + fastRule.days < days.length &&
      days[i + fastRule.days]! < from
    )
      continue;
    const day = dayOf(symbol, d);
    days2.set(d, day);
    windows.set(d, fastWindows(day));
  }
  for (let i = fastRule.days; i < days.length; i++) {
    const d = days[i]!;
    if (d < from) continue;
    const prior = days.slice(i - fastRule.days, i).map((x) => windows.get(x)!);
    const base = fastBaseline(prior);
    const got = base
      ? fastAlerts(days2.get(d)!, base, rule).map((a) => a.slot)
      : [];
    const py = want
      .filter((a) => a.sym === symbol && a.date === d)
      .map((a) => a.slot);
    for (const s of got)
      if (py.includes(s)) matched++;
      else {
        onlyTs++;
        console.log(`only here: ${symbol} ${d} slot ${s}`);
      }
    for (const s of py)
      if (!got.includes(s)) {
        onlyPy++;
        console.log(`only backtest: ${symbol} ${d} slot ${s}`);
      }
  }
}
console.log(
  `matched ${matched}, only here ${onlyTs}, only in the backtest ${onlyPy}`,
);
