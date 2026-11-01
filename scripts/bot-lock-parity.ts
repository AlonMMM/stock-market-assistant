// Checks the bot's break-even lock (version 2.9, exits.ts `lock`) against the
// Python backtest's be_lock (scripts/research/indi_bt/sim.py, research/indi-v2):
// every trade the backtest sold by the lock is walked again minute by minute
// with `nextAction` (the lock alone: no other exit), on the same inputs the
// backtest read (the stock's minute close, the option's last trade kept over
// empty minutes, the cost the walk decided on), and must sell at the same
// minute. Also prints how far the two lock levels are apart where both armed.
//
//   node --import tsx scripts/bot-lock-parity.ts <market.sqlite> <export dir with early_trades.csv and early_paths.csv>
//
// Reads the backtest's local cache and an export_early.py run (not in Git).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { yearsToExpiry } from "../packages/trading/src/bot/backtest.js";
import {
  defaultExitRules,
  nextAction,
  type BotPositionState,
  type ExitRules,
} from "../packages/trading/src/bot/exits.js";
import { parseOccSymbol } from "../packages/trading/src/options.js";

const [dbPath, dir] = process.argv.slice(2);
if (!dbPath || !dir)
  throw new Error("usage: bot-lock-parity.ts <market.sqlite> <export dir>");
const db = new DatabaseSync(dbPath, { readOnly: true });
const read = db.prepare("SELECT bars FROM bars WHERE symbol = ? AND date = ?");
const closesOf = (symbol: string, date: string): Map<number, number> => {
  const row = read.get(symbol, date) as { bars: string } | undefined;
  const bars = row ? (JSON.parse(row.bars) as number[][]) : [];
  return new Map(bars.map((b) => [b[0]!, b[4]!]));
};

// A CSV with quoted fields (the steps column holds commas).
function csv(path: string): Record<string, string>[] {
  const text = readFileSync(path, "utf8").trim();
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  const [head, ...body] = rows;
  return body.map((r) =>
    Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ""])),
  );
}

const trades = csv(join(dir, "early_trades.csv")).filter(
  (t) => t.version === "champ-1s",
);
const paths = new Map(
  csv(join(dir, "early_paths.csv")).map((p) => [p.key!, p]),
);
const rules: ExitRules = {
  ...defaultExitRules,
  checks: [],
  stopOut: -99,
  lock: { arm: 0.5 },
};

let checked = 0;
let same = 0;
const diffs: string[] = [];
for (const t of trades) {
  const p = paths.get(t.key!);
  if (!p) continue;
  const steps = p.steps!.split(";").map((s) => s.split(","));
  const lockSale = steps.find((s) => s[5] === "BE_lock");
  if (!lockSale) continue;
  // The walk's cost: the backtest decides on the price it paid (its first buy).
  const cost = Number(steps[0]![4]);
  const date = t.date!;
  const m0 = Number(t.minute);
  const c = parseOccSymbol(t.contract!);
  const right = c.right === "call" ? "C" : "P";
  const stock = closesOf(t.sym!, date);
  const option = closesOf(t.contract!, date);
  let state: BotPositionState = {
    right,
    qty: 1,
    cost,
    entryMinute: m0,
    entryStock: stock.get(m0) ?? 0,
    nights: 0,
    checksDone: [],
    morningDone: false,
  };
  let lastStock: number | null = stock.get(m0) ?? null;
  let lastOption: number | null = option.get(m0) ?? null;
  let soldAt: number | null = null;
  // The backtest's buy fills a minute after the signal; the lock looks from there.
  for (let m = m0 + 1; m < 380; m++) {
    lastStock = stock.get(m) ?? lastStock;
    lastOption = option.get(m) ?? lastOption;
    if (m <= Number(steps[0]![1])) continue;
    const d = nextAction(
      state,
      {
        minute: m,
        stock: lastStock,
        option: lastOption,
        strike: c.strike,
        years: yearsToExpiry(date, m, c.expiry),
        isExpiryDay: date === c.expiry,
        sessionBeforeExpiry: true,
        open: null,
        prevClose: null,
      },
      rules,
    );
    state = { ...state, ...d.update };
    if (d.reason === "break-even-lock") {
      soldAt = m + 1; // the backtest sells at the next minute's bar
      break;
    }
  }
  checked++;
  const want = Number(lockSale[1]);
  if (soldAt === want) same++;
  else
    diffs.push(
      `${t.key}: backtest sold at minute ${want}, the bot at ${soldAt ?? "never"}`,
    );
}
console.log(
  `${checked} lock sales checked, ${same} at the same minute (${((100 * same) / Math.max(1, checked)).toFixed(1)}%)`,
);
for (const d of diffs.slice(0, 20)) console.log("  " + d);
