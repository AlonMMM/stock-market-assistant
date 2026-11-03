// Group A (levels) test, the account: Volume 1.2.0's live-code year (v12_ parts) or 1.1.0's (pr_), the live account
// and limits (volumeAccount of the 1.2.0 code, read-only import), tune = even ISO weeks / check = odd, at 2% and 3%.
// Input: mods.json = [{name, base: "v12"|"pr", skip: [signal ids], replace: {id: trade}}]; output: acct_out.json.
// Run: sma-vol120/node_modules/.bin/tsx acct.ts <testA dir>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { volumeAccount } from "/Users/alonmo/Desktop/Personal/sma-vol120/packages/trading/src/strangle/backtest.ts";
const T = process.argv[2]!;
const L = JSON.parse(readFileSync(join(T, "in/settings.json"), "utf8"));
const load = (pre: string) => readdirSync(join(T, "in/parts")).filter((f) => f.startsWith(pre + "_")).sort().map((f) => JSON.parse(readFileSync(join(T, "in/parts", f), "utf8")));
const P: Record<string, any[]> = { v12: load("v12"), pr: load("pr") };
const mods: any[] = JSON.parse(readFileSync(join(T, process.argv[3] ?? "mods.json"), "utf8"));
const week = (d: string) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7); };
const key = (s: any) => s.date + String(s.second).padStart(6, "0");
const out: any[] = [];
for (const v of mods) {
  const skip = new Set<string>(v.skip ?? []);
  const rep: Record<string, any> = v.replace ?? {};
  const res: any = { name: v.name, views: {} };
  for (const view of v.views ?? ["year", "tune", "check"]) {
    const keep = (s: any) => view === "year" || (week(s.date) % 2 === 0) === (view === "tune");
    const rows = P[v.base ?? "v12"]!.map((r: any) => ({
      ...r,
      signals: r.signals
        .filter((s: any) => keep(s) && !skip.has(s.id))
        .map((s: any) => (s.id in rep ? (rep[s.id] === null ? { ...s, trade: undefined, outcome: "mod_none" } : { ...s, trade: { ...s.trade, ...rep[s.id] } }) : s))
        .sort((a: any, b: any) => key(a).localeCompare(key(b))),
    }));
    res.views[view] = {};
    for (const size of [2, 3]) {
      const a = volumeAccount(rows, { start: 100_000, sizePct: size, feePerContract: 0.62, maxPerStock: L.maxPerStock, limits: true, maxTradesPerDay: L.maxTradesPerDay, maxOpen: L.maxOpen, dayLossPct: L.dayLossPct });
      const tk = a.trades.filter((t: any) => t.status === "taken");
      res.views[view][size] = { end: a.end, dd: a.maxDrawdownPct, trades: tk.map((t: any) => ({ id: t.signal.id, kind: t.signal.kind, date: t.signal.date, pnl: t.pnl, ret: t.ret })) };
    }
  }
  out.push(res);
}
writeFileSync(join(T, process.argv[4] ?? "acct_out.json"), JSON.stringify(out));
for (const r of out) console.log(r.name, Object.entries(r.views).map(([k, v]: any) => `${k} ${v[2].trades.length}t $${(v[2].end / 1e3).toFixed(1)}K ${v[2].dd.toFixed(1)}% [3% $${(v[3].end / 1e3).toFixed(1)}K ${v[3].dd.toFixed(1)}%]`).join(" | "));
