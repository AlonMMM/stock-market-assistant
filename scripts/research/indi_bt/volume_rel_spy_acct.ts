// Copied from the app worktree (sma-vol120/scripts/.relspy_acct.ts, run from there: imports are relative to the app repo's scripts/).
// Temporary (not committed). Scores .relspy.ts's parts: each variant's alerts through the live code's account
// (volumeAccount, the live limits), 2% and 3%, tune = even ISO weeks / check = odd, in the same run.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { volumeAccount } from "../packages/trading/src/strangle/backtest.js";
const [dir, settingsFile] = process.argv.slice(2);
const L = JSON.parse(readFileSync(settingsFile!, "utf8"));
const parts = readdirSync(`${dir}/parts`).filter((f) => f.startsWith("rel_")).map((f) => JSON.parse(readFileSync(`${dir}/parts/${f}`, "utf8")));
const week = (d: string) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7); };
const K = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n / 1000).toFixed(1)}K`;
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(0)}%`;
const lacking = (s: any) => s.outcome === "no_fill" || s.outcome === "no_prices" || s.outcome === "no_strikes" ||
  (s.outcome === "wide_spread" && s.detail.startsWith("no book"));
// The regular alerts always (base), plus the variant's own: the relative rule only adds alerts.
const inVariant = (r: any, s: any, v: string) => s.kind === "shock" || (r.member[s.id] ?? []).includes("base") || (r.member[s.id] ?? []).includes(v);
const base = new Map<string, number>();
const gapsOut: any[] = [];
for (const v of ["base", "k3", "k4", "k6"]) {
  const cells: string[] = [];
  let added: any[] = [];
  for (const view of ["year", "tune", "check"] as const) {
    const inView = (d: string) => view === "year" || (week(d) % 2 === 0) === (view === "tune");
    const rows = parts.map((r: any) => ({ ...r, signals: r.signals.filter((s: any) => inView(s.date) && inVariant(r, s, v)) }));
    const a = [2, 3].map((size) => volumeAccount(rows, { start: 100_000, sizePct: size, feePerContract: 0.62, maxPerStock: L.maxPerStock, limits: true, maxTradesPerDay: L.maxTradesPerDay, maxOpen: L.maxOpen, dayLossPct: L.dayLossPct }));
    const tk = a[0]!.trades.filter((t: any) => t.status === "taken");
    const p = tk.map((t: any) => t.pnl).sort((x: number, y: number) => y - x);
    const giants = tk.filter((t: any) => t.ret >= 3).length;
    cells.push(`${view.padEnd(5)} ${String(tk.length).padStart(3)}t won ${tk.filter((t: any) => t.ret > 0).length} +300% ${giants} | $${(a[0]!.end / 1e3).toFixed(1)}K drop ${a[0]!.maxDrawdownPct.toFixed(1)}% w/o5 ${K(p.slice(5).reduce((x: number, y: number) => x + y, 0))} | 3% $${(a[1]!.end / 1e3).toFixed(1)}K drop ${a[1]!.maxDrawdownPct.toFixed(1)}%`);
    if (view === "year") {
      if (v === "base") for (const t of tk) base.set(t.signal.id, t.ret);
      else added = tk.filter((t: any) => !base.has(t.signal.id));
      const sigs = rows.flatMap((r: any) => r.signals);
      const newSigs = sigs.filter((s: any) => s.kind === "plan" && !(parts.find((r: any) => r.signals.includes(s))?.member[s.id] ?? []).includes("base"));
      const gaps = newSigs.filter(lacking);
      if (v !== "base") {
        cells.push(`new plan alerts ${newSigs.length}: ${Object.entries(newSigs.reduce((o: any, s: any) => ((o[s.outcome] = (o[s.outcome] ?? 0) + 1), o), {})).map(([k, n]) => `${k} ${n}`).join(", ")}`);
        cells.push(`missing books on new alerts: ${gaps.length}`);
        for (const g of gaps) gapsOut.push({ variant: v, id: g.id, symbol: g.symbol, date: g.date, second: g.second, outcome: g.outcome, detail: g.detail, expiry: g.expiry });
      }
    }
  }
  const rr = added.map((t: any) => t.ret).sort((x: number, y: number) => x - y);
  let line = "";
  if (rr.length) line = `\n   added trades ${rr.length}: median ${pct(rr[Math.floor(rr.length / 2)]!)}, won ${rr.filter((x) => x > 0).length}, +300% ${rr.filter((x) => x >= 3).length}, flat $2K ${K(2000 * rr.reduce((x, y) => x + y, 0))}; best: ${added.sort((a: any, b: any) => b.ret - a.ret).slice(0, 5).map((t: any) => `${t.signal.symbol} ${t.signal.date} ${pct(t.ret)}`).join(", ")}`;
  console.log(`${v}\n   ${cells.join("\n   ")}${line}`);
}
writeFileSync(`${dir}/gaps.json`, JSON.stringify(gapsOut, null, 1));
