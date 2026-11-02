// The user, 2026-11-02: "I would like to find trade to double up the bet" -> "Go". Volume 1.1.0 live-code year (pr_
// parts), the live limits; volumeAccount's steps with a size multiple a trade (capped at 5% of the morning's account,
// the service's position cap). Cuts fixed from the 3-year tune tertiles: last-10-min volume >= 1.2x (1.0 / 1.5
// neighbours), at the day's high (pos >= 0.955). Flat line: the plain size with the same worst drop.
import { readFileSync, readdirSync } from "node:fs";
const S = process.argv[2]!;
const L = JSON.parse(readFileSync(`${S}/live_settings.json`, "utf8"));
const N: Record<string, { rs: number; rspy: number }> = JSON.parse(readFileSync(`${S}/volyear/spynorm.json`, "utf8"));
const sc = (s: any) => N[s.id]!.rs / N[s.id]!.rspy;
const sigs: any[] = readdirSync(`${S}/volyear/parts`).filter((f) => f.startsWith("pr_")).flatMap((f) => JSON.parse(readFileSync(`${S}/volyear/parts/${f}`, "utf8")).signals.filter((s: any) => s.trade));
const week = (d: string) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7); };
function account(sizePct: number, mult: (s: any) => number, view: "year" | "tune" | "check") {
  const inView = (d: string) => view === "year" || (week(d) % 2 === 0) === (view === "tune");
  const byStock = new Map<string, any[]>();
  for (const s of sigs) if (inView(s.date)) { const k = `${s.date}|${s.symbol}`; byStock.set(k, [...(byStock.get(k) ?? []), s]); }
  const kept: any[] = [];
  for (const list of byStock.values()) { let busy = -1, n = 0; for (const s of list.sort((a, b) => a.second - b.second)) { if (s.trade.buyMinute <= busy || n >= L.maxPerStock) continue; kept.push(s); busy = s.trade.exitMinute; n++; } }
  const byDay = new Map<string, any[]>();
  for (const s of kept) byDay.set(s.date, [...(byDay.get(s.date) ?? []), s]);
  let eq = 100_000, peak = eq, drop = 0, n2 = 0; const pnls: number[] = [];
  for (const date of [...byDay.keys()].sort()) {
    const start = eq; const done: { exit: number; pnl: number }[] = [];
    for (const s of byDay.get(date)!.sort((a, b) => a.trade.buyMinute - b.trade.buyMinute || a.minute - b.minute)) {
      const t = s.trade;
      const closed = done.filter((d) => d.exit < t.buyMinute).reduce((a, d) => a + d.pnl, 0);
      if (closed <= (-L.dayLossPct / 100) * start || done.length >= L.maxTradesPerDay || done.filter((d) => d.exit >= t.buyMinute).length >= L.maxOpen) continue;
      const x = mult(s); if (x !== 1) n2++;
      const pct = Math.min(sizePct * x, Math.max(sizePct, 5));
      const qty = Math.floor(((pct / 100) * start) / (t.buy * 100));
      if (qty < 1) continue;
      done.push({ exit: t.exitMinute, pnl: qty * (t.sell - t.buy) * 100 - 0.62 * 2 * qty });
    }
    for (const d of done.sort((a, b) => a.exit - b.exit)) { eq += d.pnl; pnls.push(d.pnl); peak = Math.max(peak, eq); drop = Math.max(drop, 1 - eq / peak); }
  }
  pnls.sort((a, b) => b - a);
  return { end: eq, drop: drop * 100, wo5: pnls.slice(5).reduce((a, b) => a + b, 0), n: pnls.length, n2 };
}
// Score = the stock's 3-min volume ratio / SPY's; sizes set before the run (score_acct.py's twin).
const tier = (lo: number, hi: number, low = 0.5) => (s: any) => { const x = sc(s); if (x >= hi) return 2; if (x < lo) return low; return 1; };
const V: [string, (s: any) => number][] = [
  ["1.1.0", () => 1],
  ["x0.5 < 2, x2 >= 6", tier(2, 6)],
  ["  x0.5 < 2, x2 >= 4", tier(2, 4)],
  ["  x0.5 < 2, x2 >= 10", tier(2, 10)],
  ["  x2 >= 6 only", tier(0, 6, 1)],
  ["  x0.5 < 2 only", tier(2, 1e9)],
];

const K = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n / 1000).toFixed(1)}K`;
for (const [name, m] of V) {
  const cells = (["year", "tune", "check"] as const).map((v) => { const a = account(2, m, v), b = account(3, m, v); return `${v} $${(a.end / 1e3).toFixed(1)}K ${a.drop.toFixed(0)}% w/o5 ${K(a.wo5)} [3% $${(b.end / 1e3).toFixed(1)}K ${b.drop.toFixed(0)}%]`; });
  const y = account(2, m, "year");
  console.log(`${name.padEnd(26)} ${y.n}t ${y.n2}x2 | ${cells.join(" | ")}`);
  if (name === "1.1.0") continue;
  let lo = 0.6, hi = 5; for (let i = 0; i < 25; i++) { const mid = (lo + hi) / 2; if (account(mid, () => 1, "year").drop < y.drop) lo = mid; else hi = mid; }
  const fl = (["year", "tune", "check"] as const).map((v) => { const a = account(lo, () => 1, v); return `${v} $${(a.end / 1e3).toFixed(1)}K ${a.drop.toFixed(0)}% w/o5 ${K(a.wo5)}`; });
  console.log(`${"   flat " + lo.toFixed(2) + "%"}`.padEnd(26) + `            | ${fl.join(" | ")}`);
}
