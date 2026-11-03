// The user, 2026-11-03: "2x is scoring the same as zero for the other side ... We need to think about calculation
// equation." Skip rules on the log-scale measures (volume_score_log.py), live-code year (volumeAccount, the live limits),
// tune = even ISO weeks / check = odd, in one run. Bands set before the run. No score: kept.
import { readFileSync, readdirSync } from "node:fs";
import { volumeAccount } from "/Users/alonmo/Desktop/Personal/sma-chain-liquidity/packages/trading/src/strangle/backtest.ts";
const S = process.argv[2]!;
const L = JSON.parse(readFileSync(`${S}/live_settings.json`, "utf8"));
type Score = { rs: number; rspy: number; a: number; b: number; sd?: number; score: number | null };
const N: Record<string, Score> = JSON.parse(readFileSync(`${S}/volyear/volscore_live.json`, "utf8"));
const parts = readdirSync(`${S}/volyear/parts`).filter((f) => f.startsWith("pr_")).map((f) => JSON.parse(readFileSync(`${S}/volyear/parts/${f}`, "utf8")));
const week = (d: string) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7); };
const K = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n / 1000).toFixed(1)}K`;
// A = log2 stock ratio - log2 SPY ratio; C = the score in the stock's own noise.
function measure(s: any, m: "A" | "C"): number {
  const v = N[s.id];
  if (!v?.score || !v.sd) return NaN;
  if (m === "A") return Math.log2(v.rs) - Math.log2(v.rspy);
  return (Math.log(v.rs) - v.a - v.b * Math.log(v.rspy)) / v.sd;
}
const CUTS = { A: [1, 2, 3, 4], C: [2, 3, 4, 5] };
const V: [string, ((s: any) => boolean) | null][] = [["1.1.0", null]];
for (const m of ["A", "C"] as const) {
  const lo = [-Infinity, ...CUTS[m]], hi = [...CUTS[m], Infinity];
  lo.forEach((l, i) => V.push([`skip ${m} ${l}..${hi[i]}`, (s) => measure(s, m) >= l && measure(s, m) < hi[i]!]));
}
const base = new Map<string, number>();
for (const [name, drop] of V) {
  const cells: string[] = [];
  let removed: string[] = [];
  for (const view of ["year", "tune", "check"] as const) {
    const inView = (d: string) => view === "year" || (week(d) % 2 === 0) === (view === "tune");
    const rows = parts.map((r: any) => ({ ...r, signals: r.signals.filter((s: any) => inView(s.date) && !(drop && s.trade && drop(s))) }));
    const a = [2, 3].map((size) => volumeAccount(rows, { start: 100_000, sizePct: size, feePerContract: 0.62, maxPerStock: L.maxPerStock, limits: true, maxTradesPerDay: L.maxTradesPerDay, maxOpen: L.maxOpen, dayLossPct: L.dayLossPct }));
    const tk = a[0]!.trades.filter((t: any) => t.status === "taken");
    const p = tk.map((t: any) => t.pnl).sort((x: number, y: number) => y - x);
    cells.push(`${view} ${tk.length}t $${(a[0]!.end / 1e3).toFixed(1)}K ${a[0]!.maxDrawdownPct.toFixed(0)}% w/o5 ${K(p.slice(5).reduce((x: number, y: number) => x + y, 0))} [3% $${(a[1]!.end / 1e3).toFixed(1)}K ${a[1]!.maxDrawdownPct.toFixed(0)}%]`);
    if (view === "year") {
      if (!drop) for (const t of tk) base.set(t.signal.id, t.ret);
      else removed = [...base.keys()].filter((id) => !tk.some((t: any) => t.signal.id === id));
    }
  }
  const rr = removed.map((id) => base.get(id)!).sort((x, y) => x - y);
  let gone = "";
  if (rr.length) gone = ` | 1.1.0 trades gone ${rr.length}: median ${(100 * rr[Math.floor(rr.length / 2)]!).toFixed(0)}%, won ${rr.filter((x) => x > 0).length}, +300% ${rr.filter((x) => x >= 3).length}, flat $2K ${K(2000 * rr.reduce((x, y) => x + y, 0))}`;
  console.log(`${name}\n   ${cells.join("\n   ")}${gone}`);
}
