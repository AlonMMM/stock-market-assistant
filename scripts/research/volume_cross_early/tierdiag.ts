// Per shock alert, a tier version vs base over the year, flat $2K a trade.
import { readdirSync, readFileSync } from "node:fs";
import { tradeReturn } from "/Users/alonmo/Desktop/Personal/sma-shock-early/packages/trading/src/strangle/backtest.ts";
const dir = process.argv[2]!;
function load(n: string) {
  const m = new Map<string, any>();
  for (const f of readdirSync(`${dir}/${n}/parts`)) {
    const r = JSON.parse(readFileSync(`${dir}/${n}/parts/${f}`, "utf8"));
    for (const s of r.signals) if (s.kind === "shock") m.set(`${s.symbol} ${s.date} ${s.second}`, s);
  }
  return m;
}
const ret = (s: any) => (s?.trade ? tradeReturn(s.trade, 0.62) : null);
const usd = (x: number[]) => {
  const v = x.reduce((a, r) => a + 2000 * r, 0);
  const med = [...x].sort((p, q) => p - q)[x.length >> 1] ?? 0;
  return `${x.length} trades ${v >= 0 ? "+" : "-"}$${(Math.abs(v) / 1000).toFixed(1)}K (median ${(med * 100).toFixed(0)}%)`;
};
const HALF = process.env.HALF;
function isoWeek(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round((d.getTime() - jan4.getTime()) / 86_400_000 / 7 - 3 / 7 + ((jan4.getUTCDay() + 6) % 7) / 7);
}
const inHalf = (date: string) => !HALF || (HALF === "tune") === (isoWeek(date) % 2 === 0);
const b = load("base");
for (const v of process.argv.slice(3)) {
  const t = load(v);
  const sharedT: number[] = [], sharedB: number[] = [], added: number[] = [], lost: number[] = [];
  const big: string[] = [];
  for (const [k, s] of t) {
    if (!inHalf(s.date)) continue;
    const rt = ret(s);
    const rb = ret(b.get(k));
    if (rt !== null && rb !== null) {
      sharedT.push(rt);
      sharedB.push(rb);
      if (Math.abs(rt - rb) > 1) big.push(`${k}: ${(rb * 100).toFixed(0)}% -> ${(rt * 100).toFixed(0)}%`);
    } else if (rt !== null) {
      added.push(rt);
      if (Math.abs(rt) > 1) big.push(`added ${k} ${(rt * 100).toFixed(0)}%`);
    } else if (rb !== null) {
      lost.push(rb);
      big.push(`lost ${k} ${(rb * 100).toFixed(0)}% (${s.outcome})`);
    }
  }
  console.log(`${v}: shared ${usd(sharedT)} vs base ${usd(sharedB)}; added ${usd(added)}; lost ${usd(lost)}`);
  console.log(`  big: ${big.join("; ")}`);
}
