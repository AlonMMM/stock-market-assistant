// Copied from the app worktree (sma-vol120/scripts/.relspy_added.ts, run from there: imports are relative to the app repo's scripts/).
// Temporary: the trades each variant adds to 1.1.0, by month, and the year without April 2026.
import { readFileSync, readdirSync } from "node:fs";
import { volumeAccount } from "../packages/trading/src/strangle/backtest.js";
const [dir, settingsFile] = process.argv.slice(2);
const L = JSON.parse(readFileSync(settingsFile!, "utf8"));
const parts = readdirSync(`${dir}/parts`).filter((f) => f.startsWith("rel_")).map((f) => JSON.parse(readFileSync(`${dir}/parts/${f}`, "utf8")));
const inV = (r: any, s: any, v: string) => s.kind === "shock" || (r.member[s.id] ?? []).includes("base") || (r.member[s.id] ?? []).includes(v);
const acct = (v: string, keep: (d: string) => boolean) => volumeAccount(parts.map((r: any) => ({ ...r, signals: r.signals.filter((s: any) => keep(s.date) && inV(r, s, v)) })),
  { start: 100_000, sizePct: 2, feePerContract: 0.62, maxPerStock: L.maxPerStock, limits: true, maxTradesPerDay: L.maxTradesPerDay, maxOpen: L.maxOpen, dayLossPct: L.dayLossPct });
const all = () => true, noApr = (d: string) => !d.startsWith("2026-04");
const ids = new Set(acct("base", all).trades.filter((t: any) => t.status === "taken").map((t: any) => t.signal.id));
for (const v of ["k3", "k4", "k6"]) {
  const tk = acct(v, all).trades.filter((t: any) => t.status === "taken" && !ids.has(t.signal.id));
  const by: Record<string, number[]> = {};
  for (const t of tk) (by[t.signal.date.slice(0, 7)] ??= []).push(t.ret);
  console.log(v, Object.entries(by).sort().map(([m, r]) => `${m}: ${r.length} (${r.map((x) => `${Math.round(100 * x)}%`).join(" ")})`).join(" | "));
  console.log(`   without April 2026: ${v} $${(acct(v, noApr).end / 1e3).toFixed(1)}K vs 1.1.0 $${(acct("base", noApr).end / 1e3).toFixed(1)}K`);
}
