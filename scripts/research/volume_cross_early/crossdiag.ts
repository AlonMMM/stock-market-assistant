// The shock trades, base vs an early version, by alert (flat $2K a trade, after fees, before the account's limits).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tradeReturn, type VolumeSignal } from "../packages/trading/src/strangle/backtest.js";
const [dir, a, b] = process.argv.slice(2);
const load = (n: string) => {
  const m = new Map<string, VolumeSignal>();
  for (const f of readdirSync(join(dir!, n, "parts")))
    for (const s of JSON.parse(readFileSync(join(dir!, n, "parts", f), "utf8")).signals as VolumeSignal[])
      if (s.kind === "shock") m.set(s.id, s);
  return m;
};
const A = load(a!), B = load(b!);
const r = (s?: VolumeSignal) => (s?.trade ? tradeReturn(s.trade, 0.62) : null);
const groups: Record<string, { n: number; a: number; b: number; ex: string[] }> = {};
for (const [id, sb] of B) {
  const sa = A.get(id);
  const ra = r(sa), rb = r(sb);
  if (ra === null && rb === null) continue;
  let g = "both traded, same";
  if (ra === null) g = sb.trade!.exitReason === ("unconfirmed" as never) ? "new, sold at the check" : "new, kept";
  else if (rb === null) g = `dropped (now ${sb.outcome})`;
  else if (sb.trade!.exitReason === ("unconfirmed" as never)) g = "both, early sold at the check";
  else if (Math.abs(ra - rb) > 1e-9) g = "both, early buy kept";
  const x = (groups[g] ??= { n: 0, a: 0, b: 0, ex: [] });
  x.n++; x.a += 2000 * (ra ?? 0); x.b += 2000 * (rb ?? 0);
  if (x.ex.length < 6) x.ex.push(`${sb.symbol} ${sb.date} ${ra === null ? "—" : (ra * 100).toFixed(0) + "%"}→${rb === null ? "—" : (rb * 100).toFixed(0) + "%"}`);
}
for (const [g, x] of Object.entries(groups)) console.log(`${g}: ${x.n} alerts, ${a} $${(x.a / 1000).toFixed(1)}K → ${b} $${(x.b / 1000).toFixed(1)}K | ${x.ex.join(", ")}`);
