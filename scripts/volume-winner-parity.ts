// Checks the Volume bot's winner rules (2026-10-28) against the backtest they
// come from (leg_seconds.py with STR_CROSS_MAX=15 STR_AM_MIN=1.1
// STR_NOSTOP_MIN=30, research/indi-v2): for every backtest trade, the burst
// the bot reads at the alert, and the minute its minute-close give-back sells.
//
//   node --import tsx scripts/volume-winner-parity.ts <trades.json>
//
// <trades.json>: per trade the date, stock, alert minute, unit (S30), side,
// the stock at the cross (spot), buy and exit minutes, the backtest's burst
// (`am`, the side's way) and the day's minute closes (local data, not in Git).
import { readFileSync } from "node:fs";
import {
  burstOf,
  minuteCloseExit,
} from "../packages/trading/src/strangle/decide.js";
import { defaultStrangleSettings } from "../packages/trading/src/strangle/settings.js";

interface Row {
  date: string;
  sym: string;
  alertMinute: number;
  unit: number;
  side: "C" | "P";
  spot: number;
  buyMinute: number;
  exitMinute: number;
  am: number | null;
  closes: { m: number; c: number }[];
}

const [path] = process.argv.slice(2);
if (!path) throw new Error("usage: volume-winner-parity.ts <trades.json>");
const rows = JSON.parse(readFileSync(path, "utf8")) as Row[];
const s = { ...defaultStrangleSettings, endMinute: 360 };
let burstOk = 0;
let exitOk = 0;
const misses: string[] = [];
for (const r of rows) {
  const up = burstOf(r.closes, r.alertMinute, r.unit);
  const sideWay = up === null ? null : r.side === "C" ? up : -up;
  const same =
    (sideWay === null && r.am === null) ||
    (sideWay !== null && r.am !== null && Math.abs(sideWay - r.am) < 1e-9);
  if (same) burstOk++;
  else misses.push(`${r.date} ${r.sym}: burst ${sideWay} vs ${r.am}`);
  // The sale minute: the first minute the walk sells, or the end.
  let sold: number | null = null;
  for (let m = r.buyMinute + 1; m <= 360 && sold === null; m++) {
    const got = minuteCloseExit(
      r.closes.filter((b) => b.m <= m),
      r.spot,
      r.side,
      r.unit,
      r.buyMinute,
      m,
      s,
    );
    if (got.exit) sold = m;
  }
  if (sold === r.exitMinute) exitOk++;
  else
    misses.push(
      `${r.date} ${r.sym}: sold at minute ${sold} vs the backtest's ${r.exitMinute}`,
    );
}
console.log(
  `${rows.length} trades: the burst matches on ${burstOk}, the sale minute on ${exitOk}`,
);
for (const m of misses.slice(0, 20)) console.log(`  ${m}`);
