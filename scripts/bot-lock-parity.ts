// Checks the bot's break-even lock (version 2.9, exits.ts `lock`) against the
// Python backtest's be_lock (scripts/research/indi_bt/sim.py, research/indi-v2):
// every trade the backtest sold by the lock is walked again with `nextAction`
// (the lock alone: no other exit) on the backtest's own minute inputs (the
// stock's minute close and the option mark its walk read, the book's mid each
// stock minute, and the cost it decided on), and must sell at the same minute.
// The inputs come from the research side (scratchpad lock_inputs.py: one JSON
// per export, `lock_inputs.json`).
//
//   node --import tsx scripts/bot-lock-parity.ts <lock_inputs.json>
import { readFileSync } from "node:fs";
import { yearsToExpiry } from "../packages/trading/src/bot/backtest.js";
import {
  defaultExitRules,
  nextAction,
  type BotPositionState,
  type ExitRules,
} from "../packages/trading/src/bot/exits.js";
import { parseOccSymbol } from "../packages/trading/src/options.js";

interface LockTrade {
  key: string;
  date: string;
  minute: number;
  contract: string;
  right: "C" | "P";
  cost: number;
  buy: number; // the minute the backtest bought
  sold: number; // the minute it sold by the lock
  rows: [minute: number, option: number, stock: number | null][];
}

const [path] = process.argv.slice(2);
if (!path) throw new Error("usage: bot-lock-parity.ts <lock_inputs.json>");
const trades = JSON.parse(readFileSync(path, "utf8")) as LockTrade[];
const rules: ExitRules = {
  ...defaultExitRules,
  checks: [],
  stopOut: -99,
  lock: { arm: 0.5 },
};

let same = 0;
const diffs: string[] = [];
for (const t of trades) {
  const c = parseOccSymbol(t.contract);
  let state: BotPositionState = {
    right: t.right,
    qty: 1,
    cost: t.cost,
    entryMinute: t.minute,
    entryStock: 0,
    nights: 0,
    checksDone: [],
    morningDone: false,
  };
  let soldAt: number | null = null;
  // The backtest decides on a bar and sells at its next one.
  const rows = t.rows.filter(([m]) => m > t.buy);
  for (let i = 0; i < rows.length && soldAt === null; i++) {
    const [m, option, stock] = rows[i]!;
    const d = nextAction(
      state,
      {
        minute: m,
        stock,
        option,
        strike: c.strike,
        years: yearsToExpiry(t.date, m, c.expiry),
        isExpiryDay: t.date === c.expiry,
        sessionBeforeExpiry: true,
        open: null,
        prevClose: null,
      },
      rules,
    );
    state = { ...state, ...d.update };
    if (d.reason === "break-even-lock") soldAt = rows[i + 1]?.[0] ?? m;
  }
  if (soldAt === t.sold) same++;
  else
    diffs.push(
      `${t.key}: backtest sold at minute ${t.sold}, the bot at ${soldAt ?? "never"}`,
    );
}
console.log(
  `${trades.length} lock sales checked, ${same} at the same minute (${((100 * same) / Math.max(1, trades.length)).toFixed(1)}%)`,
);
for (const d of diffs.slice(0, 20)) console.log("  " + d);
