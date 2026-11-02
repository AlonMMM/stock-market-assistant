// The user, 2026-11-03: "call it volume score. and go". Volume score skips on the live-code year (live account, limits).
// (volumeAccount), tune = even ISO weeks / check = odd, in one run. Levels set before the run.
import { readFileSync, readdirSync } from "node:fs";
import { volumeAccount } from "/Users/alonmo/Desktop/Personal/sma-chain-liquidity/packages/trading/src/strangle/backtest.ts";
const S = process.argv[2]!;
const L = JSON.parse(readFileSync(`${S}/live_settings.json`, "utf8"));
const N: Record<string, { score: number | null }> = JSON.parse(readFileSync(`${S}/volyear/volscore_live.json`, "utf8"));
const parts = readdirSync(`${S}/volyear/parts`).filter((f) => f.startsWith("pr_")).map((f) => JSON.parse(readFileSync(`${S}/volyear/parts/${f}`, "utf8")));
const week = (d: string) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7); };
const K = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n / 1000).toFixed(1)}K`;
const n = (s: any) => N[s.id];
// Volume score = stock ratio / (e^a * SPY ratio^b); cuts from the 3-year tune weeks (volscore_3y.py). No score: kept.
const sc = (s: any) => n(s)?.score ?? NaN;
const V: [string, ((s: any) => boolean) | null][] = [
  ["1.1.0", null],
  ["skip score >= 16.5 (pick)", (s) => sc(s) >= 16.5],
  ["  skip quintile 2 (3.1-4.8)", (s) => sc(s) >= 3.1 && sc(s) < 4.8],
  ["  skip 1-2", (s) => sc(s) >= 1 && sc(s) < 2],
  ["  skip 1-3", (s) => sc(s) >= 1 && sc(s) < 3],
];
const base = new Map<string, number>();
for (const [name, drop] of V) {
  const cells: string[] = [];
  let removed: any[] = [];
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
  const gone = rr.length ? ` | 1.1.0 trades gone ${rr.length}: median ${(100 * rr[Math.floor(rr.length / 2)]!).toFixed(0)}%, won ${rr.filter((x) => x > 0).length}, +300% ${rr.filter((x) => x >= 3).length}, flat $2K ${K(2000 * rr.reduce((x, y) => x + y, 0))}` : "";
  console.log(`${name}\n   ${cells.join("\n   ")}${gone}`);
}
