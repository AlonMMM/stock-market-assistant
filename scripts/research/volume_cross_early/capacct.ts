// The burst-window versions under a new account (the user, 2026-11-07: "You can remove the limitation. Keep only
// these - max 3 per stock and no more than 35% of the account can be opened at once").
// Account: a stock's trades of a day one at a time, up to 3; no trades-a-day, open-count or day-loss limit; a buy is
// refused when the cost of the open trades plus its own would pass 35% of the morning's account. Sized from the
// morning's account, as volumeAccount. Tune = even ISO entry weeks, check = odd; the pick on tune, check for it only.
//   IDEAS=BW node --import tsx scripts/.capacct.ts <runsDir> base BW10 ...
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tradeReturn, type VolumeSignal } from "../packages/trading/src/strangle/backtest.js";

const [dir, ...names] = process.argv.slice(2);
const fee = 0.62;
const PER_STOCK = Number(process.env.PER_STOCK ?? 3);
const CAP = Number(process.env.CAP ?? 35) / 100;

function load(name: string): VolumeSignal[] {
  const out: VolumeSignal[] = [];
  const p = join(dir!, name, "parts");
  for (const f of readdirSync(p)) out.push(...(JSON.parse(readFileSync(join(p, f), "utf8")).signals as VolumeSignal[]));
  return out.filter((s) => s.trade);
}
function isoWeek(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round((d.getTime() - jan4.getTime()) / 86_400_000 / 7 - 3 / 7 + ((jan4.getUTCDay() + 6) % 7) / 7);
}
const halfOf = (date: string) => (isoWeek(date) % 2 === 0 ? "tune" : "check");

function account(sigs: VolumeSignal[], sizePct: number) {
  const byStockDay = new Map<string, VolumeSignal[]>();
  for (const s of sigs) {
    const k = `${s.date}|${s.symbol}`;
    if (!byStockDay.has(k)) byStockDay.set(k, []);
    byStockDay.get(k)!.push(s);
  }
  const kept: VolumeSignal[] = [];
  for (const list of byStockDay.values()) {
    let busyTo = -1;
    let n = 0;
    for (const s of list.sort((a, b) => a.second - b.second)) {
      if (s.trade!.buyMinute <= busyTo || n >= PER_STOCK) continue;
      kept.push(s);
      busyTo = s.trade!.exitMinute;
      n++;
    }
  }
  const byDay = new Map<string, VolumeSignal[]>();
  for (const s of kept) {
    if (!byDay.has(s.date)) byDay.set(s.date, []);
    byDay.get(s.date)!.push(s);
  }
  let equity = 100_000, peak = equity, drop = 0, capped = 0;
  const taken: { s: VolumeSignal; pnl: number }[] = [];
  for (const date of [...byDay.keys()].sort()) {
    const start = equity;
    const open: { exit: number; cost: number }[] = [];
    const day: { s: VolumeSignal; pnl: number }[] = [];
    for (const s of byDay.get(date)!.sort((a, b) => a.trade!.buyMinute - b.trade!.buyMinute || a.minute - b.minute)) {
      const t = s.trade!;
      const qty = Math.floor(((sizePct / 100) * start) / (t.buy * 100));
      if (qty < 1) continue;
      const cost = qty * t.buy * 100;
      const inUse = open.filter((o) => o.exit >= t.buyMinute).reduce((a, o) => a + o.cost, 0);
      if (inUse + cost > CAP * start) {
        capped++;
        continue;
      }
      open.push({ exit: t.exitMinute, cost });
      day.push({ s, pnl: qty * (t.sell - t.buy) * 100 - fee * 2 * qty });
    }
    for (const x of [...day].sort((a, b) => a.s.trade!.exitMinute - b.s.trade!.exitMinute)) {
      equity += x.pnl;
      peak = Math.max(peak, equity);
      drop = Math.max(drop, 1 - equity / peak);
    }
    taken.push(...day);
  }
  return { end: equity, drop: drop * 100, taken, capped };
}
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1]! : 0;
};
const k = (v: number) => `${v < 0 ? "-" : "+"}$${(Math.abs(v) / 1000).toFixed(1)}K`;
function row(name: string, sigs: VolumeSignal[], h: string) {
  const only = sigs.filter((s) => halfOf(s.date) === h);
  const a2 = account(only, 2), a3 = account(only, 3);
  const rets = a2.taken.map((x) => tradeReturn(x.s.trade!, fee));
  const best5 = a2.taken.map((x) => x.pnl).sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
  const shocks = a2.taken.filter((x) => x.s.kind === "shock").length;
  const yr = (y: string) => a2.taken.filter((x) => x.s.date.startsWith(y)).reduce((a, x) => a + x.pnl, 0);
  return {
    name, end2: a2.end,
    line: `| ${name} | ${a2.taken.length} (${shocks} shock) | ${rets.filter((r) => r > 0).length} | ${(median(rets) * 100).toFixed(0)}% | $${(a2.end / 1000).toFixed(1)}K (${a2.drop.toFixed(0)}%) | $${(a3.end / 1000).toFixed(1)}K (${a3.drop.toFixed(0)}%) | ${k(a2.end - 100_000 - best5)} | ${k(rets.filter((r) => r < 3).reduce((a, r) => a + 2000 * r, 0))} | ${rets.filter((r) => r >= 3).length} | ${a2.capped} / ${a3.capped} | ${k(yr("2025"))} / ${k(yr("2026"))} |`,
  };
}
const all = new Map(names.map((n) => [n, load(n)]));
const head = "| Version | Trades | Winners | Median | 2% (drop) | 3% (drop) | W/o best 5 (2%) | Non-giant (flat $2K) | Giants | Refused by the 35% cap (2% / 3%) | 2025 / 2026 (2%) |\n|---|---|---|---|---|---|---|---|---|---|---|";
console.log(`Account: ${PER_STOCK} a stock a day, open cost <= ${CAP * 100}% of the morning's account, no other limit\n\n## Tune\n${head}`);
const tune = names.map((n) => row(n, all.get(n)!, "tune"));
for (const r of tune) console.log(r.line);
const picks = (process.env.IDEAS ?? "BW").split(",").map((p) => tune.filter((r) => r.name.startsWith(p)).sort((a, b) => b.end2 - a.end2)[0]?.name).filter(Boolean) as string[];
console.log(`\n🎯 picks on tune: ${picks.join(", ")}\n\n## Check (base and the picks)\n${head}`);
for (const n of ["base", ...picks]) console.log(row(n, all.get(n)!, "check").line);
