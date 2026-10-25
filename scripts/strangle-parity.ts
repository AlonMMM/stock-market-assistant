// Checks the strangle bot's TypeScript decisions against the backtest it was
// ported from (zero9.py, research/indi-v2): for every trade of the export,
// the first alert minute and side, the minute the side is confirmed and the
// kept leg, and the kept leg's exit minute on the trail.
//
//   node --import tsx scripts/strangle-parity.ts <market.sqlite> <trades.csv>
//
// Reads the backtest's local bar cache (data/local/x/bt, not in Git).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { MinuteBar } from "../packages/trading/src/bot/signal.js";
import { priorLevels } from "../packages/trading/src/bot/levels.js";
import {
  alerts,
  firstAlert,
  windows,
} from "../packages/trading/src/strangle/alert.js";
import { keptExit, sideOf } from "../packages/trading/src/strangle/decide.js";
import { defaultStrangleSettings as S } from "../packages/trading/src/strangle/settings.js";

const [dbPath, csvPath] = process.argv.slice(2);
if (!dbPath || !csvPath)
  throw new Error("usage: strangle-parity.ts <market.sqlite> <trades.csv>");
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

const lines = readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
const head = lines[0]!.split(",");
const col = (row: string[], name: string) => row[head.indexOf(name)]!;
let n = 0;
const bad = { alert: 0, confirm: 0, exit: 0 };
const examples: string[] = [];
for (const line of lines.slice(1)) {
  const r = line.split(",");
  const date = col(r, "date"),
    sym = col(r, "sym");
  const i = calendar.indexOf(date);
  const bars = day(sym, date);
  const hist = calendar.slice(i - 20, i).map((d) => windows(day(sym, d)));
  const first = firstAlert(alerts(bars, hist), S.firstMinute, S.lastMinute);
  const want = { minute: Number(col(r, "minute")), side: col(r, "alert") };
  n++;
  if (!first || first.minute !== want.minute || first.side !== want.side) {
    bad.alert++;
    if (examples.length < 8)
      examples.push(
        `alert ${sym} ${date}: ts ${JSON.stringify(first)} vs py ${JSON.stringify(want)}`,
      );
    continue;
  }
  // The side: minute closes from the fill, the unit from the 5 sessions before.
  const lv = priorLevels(calendar.slice(i - 5, i).map((d) => day(sym, d)));
  const fill = Number(col(r, "fill_minute"));
  const by = new Map(bars.map((b) => [b.m, b]));
  const stock0 = Number(col(r, "stock_at_fill"));
  let conf: { minute: number; side: "C" | "P" } | null = null;
  for (let m = fill + 1; m <= Math.min(want.minute + S.waitMinutes, 360); m++) {
    const b = by.get(m);
    if (!b || !lv) continue;
    const side = sideOf(b.c, stock0, lv.unit, S);
    if (side) {
      conf = { minute: m, side };
      break;
    }
  }
  const pyConf =
    col(r, "confirm_minute") === ""
      ? null
      : {
          minute: Number(col(r, "confirm_minute")),
          side: col(r, "kept") === "call" ? "C" : "P",
        };
  if (JSON.stringify(conf) !== JSON.stringify(pyConf)) {
    bad.confirm++;
    if (examples.length < 8)
      examples.push(
        `side ${sym} ${date}: ts ${JSON.stringify(conf)} vs py ${JSON.stringify(pyConf)} (unit ${lv?.unit})`,
      );
    continue;
  }
  if (!conf) continue;
  // The kept leg's trail on its minute closes.
  const leg = conf.side === "C" ? col(r, "call") : col(r, "put");
  const ob = new Map(day(leg, date).map((b) => [b.m, b]));
  let last: number | null = null;
  for (let m = 0; m <= conf.minute; m++) if (ob.has(m)) last = ob.get(m)!.c;
  let peak = last ?? 0,
    exit: number | null = null;
  for (let m = conf.minute + 1; m <= 360; m++) {
    const b = ob.get(m);
    if (b) last = b.c;
    if (last === null) continue;
    peak = Math.max(peak, last);
    if (keptExit(last, peak, m, S)) {
      exit = m;
      break;
    }
  }
  const pyExit = Number(col(r, "exit_minute"));
  if (exit !== pyExit) {
    bad.exit++;
    if (examples.length < 8)
      examples.push(`exit ${sym} ${date}: ts ${exit} vs py ${pyExit}`);
  }
}
console.log(
  `${n} trades: alert differs ${bad.alert}, side differs ${bad.confirm}, exit differs ${bad.exit}`,
);
for (const e of examples) console.log("  " + e);
