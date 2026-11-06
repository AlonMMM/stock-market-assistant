// Volume bot: a slower plan cross and an early shock buy (research, 2026-11-06).
//
// The user, 2026-11-06: "can you try on the plan 30-60 seconds? and for the shock use 50% from the current rult
// after 10 seoncs and confirm after 30sec we did not wrong (sell if we did)".
//
// Built on Volume 1.3.0 (live), the app's engine (origin/main 62334b8 + the research-only SHOCK_EARLY switch in
// runVolumeStock), the saved settings, 2025-11-03 .. 2026-10-30, real books only, a local read-only snapshot of
// production D1 with the stock seconds rebuilt from Alpaca's full SIP tape (2026-11-06).
// Versions (set before the run):
//   base     1.3.0: plan cross within 15 s; shock: touch within 20 s, then 5 checks within 300 s.
//   P30/P60  the plan's cross window 30 s / 60 s (crossMaxSeconds).
//   E50-30   shock: bought 10 s after the alert when the stock has gone 50% of the way to a side line (that side),
//            sold at the bid 30 s after the alert unless that side's full line was touched by then (the thesis).
//   E50-20   the same, confirmed by 20 s (today's touch window).
//   E30-30   30% of the way at 10 s, confirmed by 30 s.
// Tune = even ISO entry weeks, check = odd; each half's account from $100K with the live limits.
//
//   node --import tsx scripts/.crosslab.ts <runsDir> base P30 P60 E50-30 E50-20 E30-30
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  tradeReturn,
  volumeAccount,
  type VolumeStockRun,
} from "../packages/trading/src/strangle/backtest.js";

const [dir, ...names] = process.argv.slice(2);
const fee = 0.62;

function load(name: string): VolumeStockRun[] {
  const bySym = new Map<string, VolumeStockRun>();
  const p = join(dir!, name, "parts");
  for (const f of readdirSync(p).sort()) {
    const r = JSON.parse(readFileSync(join(p, f), "utf8")) as VolumeStockRun;
    let run = bySym.get(r.symbol);
    if (!run) bySym.set(r.symbol, (run = { symbol: r.symbol, signals: [], ignored: r.ignored }));
    run.signals.push(...r.signals);
  }
  return [...bySym.values()];
}

function isoWeek(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const y = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(y, 0, 4));
  return 1 + Math.round((d.getTime() - jan4.getTime()) / 86_400_000 / 7 - 3 / 7 + ((jan4.getUTCDay() + 6) % 7) / 7);
}
const halfOf = (date: string) => (isoWeek(date) % 2 === 0 ? "tune" : "check");
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1]! : 0;
};
const k = (v: number) => `${v < 0 ? "-" : "+"}$${(Math.abs(v) / 1000).toFixed(1)}K`;
const money = (sizePct: number) => ({
  start: 100_000, sizePct, feePerContract: fee, maxPerStock: 2, limits: true, maxTradesPerDay: 15, maxOpen: 5, dayLossPct: 7.5,
});

function row(name: string, runs: VolumeStockRun[], h: "tune" | "check") {
  const only = runs.map((r) => ({ ...r, signals: r.signals.filter((s) => halfOf(s.date) === h) }));
  const a2 = volumeAccount(only, money(2));
  const a3 = volumeAccount(only, money(3));
  const taken = a2.trades.filter((t) => t.status === "taken");
  const rets = taken.map((t) => tradeReturn(t.signal.trade!, fee));
  const pnl = taken.map((t) => t.pnl).sort((x, y) => y - x);
  const best5 = pnl.slice(0, 5).reduce((s, x) => s + x, 0);
  const nonGiant = rets.filter((r) => r < 3).reduce((s, r) => s + 2000 * r, 0);
  const year = (y: string) => taken.filter((t) => t.signal.date.startsWith(y)).reduce((s, t) => s + t.pnl, 0);
  const shocks = taken.filter((t) => t.signal.kind === "shock");
  const unconf = taken.filter((t) => t.signal.trade!.exitReason === ("unconfirmed" as never));
  return {
    name,
    line: `| ${name} | ${taken.length} (${shocks.length} shock${unconf.length ? `, ${unconf.length} sold at the check` : ""}) | ${rets.filter((r) => r > 0).length} | ${(median(rets) * 100).toFixed(0)}% | $${(a2.end / 1000).toFixed(1)}K (${a2.maxDrawdownPct.toFixed(0)}%) | $${(a3.end / 1000).toFixed(1)}K (${a3.maxDrawdownPct.toFixed(0)}%) | ${k(a2.end - 100_000 - best5)} | ${k(nonGiant)} | ${rets.filter((r) => r >= 3).length} | ${k(year("2025"))} / ${k(year("2026"))} |`,
    end2: a2.end,
    drop2: a2.maxDrawdownPct,
  };
}

const all = new Map(names.map((n) => [n, load(n)]));
const head =
  "| Version | Trades | Winners | Median | 2% (drop) | 3% (drop) | W/o best 5 (2%) | Non-giant (flat $2K) | Giants | 2025 / 2026 (2%) |\n|---|---|---|---|---|---|---|---|---|---|";
console.log("## Tune (even ISO entry weeks)\n" + head);
const tune = names.map((n) => row(n, all.get(n)!, "tune"));
for (const r of tune) console.log(r.line);
// The pick of each idea on tune: the most 2% money (the drop read in words).
const pick = (prefix: string) =>
  tune.filter((r) => r.name.startsWith(prefix)).sort((a, b) => b.end2 - a.end2)[0]?.name;
const picks = [pick("P"), pick("E")].filter(Boolean) as string[];
console.log(`\n🎯 picks on tune: ${picks.join(", ")}`);
console.log("\n## Check (odd ISO entry weeks), base and the picks\n" + head);
for (const n of ["base", ...picks]) console.log(row(n, all.get(n)!, "check").line);
