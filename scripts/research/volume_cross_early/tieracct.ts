import { readdirSync, readFileSync } from "node:fs";
import { volumeAccount, type VolumeStockRun } from "/Users/alonmo/Desktop/Personal/sma-shock-early/packages/trading/src/strangle/backtest.ts";
const dir = process.argv[2]!;
function isoWeek(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round((d.getTime() - jan4.getTime()) / 86_400_000 / 7 - 3 / 7 + ((jan4.getUTCDay() + 6) % 7) / 7);
}
function load(n: string, h: string) {
  const by = new Map<string, VolumeStockRun>();
  for (const f of readdirSync(`${dir}/${n}/parts`).sort()) {
    const r = JSON.parse(readFileSync(`${dir}/${n}/parts/${f}`, "utf8"));
    let run = by.get(r.symbol);
    if (!run) by.set(r.symbol, (run = { symbol: r.symbol, signals: [], ignored: r.ignored }));
    run.signals.push(...r.signals.filter((s: any) => (h === "tune") === (isoWeek(s.date) % 2 === 0)));
  }
  return [...by.values()];
}
const money = { start: 100_000, sizePct: 2, feePerContract: 0.62, maxPerStock: 2, limits: true, maxTradesPerDay: 15, maxOpen: 5, dayLossPct: 7.5 };
for (const h of ["tune", "check"]) {
  const m = (n: string) => new Map(volumeAccount(load(n, h), money).trades.filter((t) => t.status === "taken").map((t) => [`${t.signal.symbol} ${t.signal.date} ${t.signal.second} ${t.signal.kind}`, t.pnl]));
  const b = m("base"), t = m(process.argv[3]!);
  const sum = (xs: number[]) => `${xs.length} ${(xs.reduce((a, x) => a + x, 0) / 1000).toFixed(1)}K`;
  const both = [...b.keys()].filter((k) => t.has(k));
  const onlyB = [...b.entries()].filter(([k]) => !t.has(k));
  const onlyT = [...t.entries()].filter(([k]) => !b.has(k));
  console.log(`${h}: both base ${sum(both.map((k) => b.get(k)!))} -> ${sum(both.map((k) => t.get(k)!))}; only base ${sum(onlyB.map((x) => x[1]))}; only ${process.argv[3]} ${sum(onlyT.map((x) => x[1]))}`);
  console.log("  only base:", onlyB.sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}K`).join("; "));
}
