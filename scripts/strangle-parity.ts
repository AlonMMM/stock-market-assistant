// Checks the alert leg bot's TypeScript decisions against the backtest they
// were ported from (strangle_more.py, research/indi-v2): for every trade of the
// export, the first alert's minute and side, the minute the side comes and
// which side, and the minute the stock's give-back sells the leg.
//
//   node --import tsx scripts/strangle-parity.ts <market.sqlite> <trades.csv>
//
// <trades.csv> is strangle_more.py's BT_EXPORT (columns minute, alert,
// stock_at_fill, side_minute, kept, buy_minute, exit_minute, leg). Reads the
// backtest's local bar cache (data/local/x/bt, not in Git).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { MinuteBar } from "../packages/trading/src/bot/signal.js";
import { priorLevels } from "../packages/trading/src/bot/levels.js";
import {
  alerts,
  firstAlert,
  windows,
} from "../packages/trading/src/strangle/alert.js";
import {
  bestOf,
  giveBackExit,
  sideOf,
} from "../packages/trading/src/strangle/decide.js";
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
const bad = { alert: 0, side: 0, buy: 0, exit: 0 };
const examples: string[] = [];
const note = (s: string) => examples.length < 8 && examples.push(s);
for (const line of lines.slice(1)) {
  const r = line.split(",");
  const date = col(r, "date"),
    sym = col(r, "sym");
  const i = calendar.indexOf(date);
  const bars = day(sym, date);
  n++;
  const first = firstAlert(
    alerts(
      bars,
      calendar.slice(i - 20, i).map((d) => windows(day(sym, d))),
    ),
    S.firstMinute,
    S.lastMinute,
  );
  const want = { minute: Number(col(r, "minute")), side: col(r, "alert") };
  if (!first || first.minute !== want.minute || first.side !== want.side) {
    bad.alert++;
    note(
      `alert ${sym} ${date}: ts ${JSON.stringify(first)} vs py ${JSON.stringify(want)}`,
    );
    continue;
  }
  const unit =
    priorLevels(calendar.slice(i - 5, i).map((d) => day(sym, d)))?.unit ?? 0;
  const by = new Map(bars.map((b) => [b.m, b]));
  const ref = Number(col(r, "stock_at_fill"));
  // The side on minute closes from two minutes after the alert. The backtest
  // also waited until both strangle legs had printed (its pair fill), so on a
  // few trades (2 of 499) its side comes a few minutes later than here.
  let side: { minute: number; side: "C" | "P" } | null = null;
  for (
    let m = want.minute + 2;
    m <= Math.min(want.minute + S.waitMinutes, 360);
    m++
  ) {
    const b = by.get(m);
    if (!b) continue;
    const s = sideOf(b.c, ref, unit, S);
    if (s) {
      side = { minute: m, side: s };
      break;
    }
  }
  const py =
    col(r, "side_minute") === ""
      ? null
      : {
          minute: Number(col(r, "side_minute")),
          side: col(r, "kept") === "call" ? "C" : "P",
        };
  if (JSON.stringify(side) !== JSON.stringify(py)) {
    bad.side++;
    note(
      `side ${sym} ${date}: ts ${JSON.stringify(side)} vs py ${JSON.stringify(py)}`,
    );
    continue;
  }
  if (!side) continue;
  const lb = new Map(day(col(r, "leg"), date).map((b) => [b.m, b]));
  let buy: number | null = null;
  for (let m = side.minute; m <= side.minute + 3; m++)
    if (lb.has(m)) {
      buy = m;
      break;
    }
  if (buy !== Number(col(r, "buy_minute"))) {
    bad.buy++;
    note(`buy ${sym} ${date}: ts ${buy} vs py ${col(r, "buy_minute")}`);
    continue;
  }
  let best = by.get(side.minute)?.c ?? ref;
  let exit: number | null = null;
  for (let m = buy! + 1; m <= 360; m++) {
    const b = by.get(m);
    if (b) best = bestOf(best, b.c, side.side);
    if (giveBackExit(b?.c ?? 0, best, side.side, unit, m, S)) {
      exit = m;
      break;
    }
  }
  if (exit !== Number(col(r, "exit_minute"))) {
    bad.exit++;
    note(`exit ${sym} ${date}: ts ${exit} vs py ${col(r, "exit_minute")}`);
  }
}
console.log(
  `${n} trades: alert differs ${bad.alert}, side differs ${bad.side}, buy differs ${bad.buy}, exit differs ${bad.exit}`,
);
for (const e of examples) console.log("  " + e);
