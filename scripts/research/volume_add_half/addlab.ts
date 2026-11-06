// Volume bot: add half on a same-direction alert while the open leg is up (research, 2026-11-06).
//
// The user, 2026-11-06: "What if we put extra half of the position if we get another alert during an open
// position in the same direction, and the position is up small, like maybe more than 10%, let's say."
//
// Built on Volume 1.3.0 (the version live), the app's own engine (origin/main runVolumeStock through
// handleVolumeBacktest, `.addyear.ts`): 50 live stocks, 2025-11-03 .. 2026-10-30, the saved settings
// (3% size, 15 a day, 2 a stock, 5 open, 7.5% day loss, -80% broker stop, delta 0.20, floor 200), real books
// only. Every alert carries its own simulated trade, also the ones the account refuses as "busy".
//
// The event: an alert the account refuses as busy (its stock's taken trade still open), whose own trade is the
// same right (call while holding a call, put while holding a put; plan or shock), bought after the open leg's
// buy and before its sale, while the open leg's bid >= (1 + K) x its buy price. The open leg's book at the new
// alert's buy second t (= its side second + 2): the 1-second book (option_seconds, the engine's buy rule), else
// the minute book as the last minute closed (bookAt m - 1, Databento + saved seconds). One add per position.
//
// Variants (set before the run):
//   base  1.3.0 as is.
//   A K   add floor(half the open contracts), at least 1, of the OPEN contract at t, bought as the engine buys
//         (mid + a quarter of the spread; the ask 10 s later when the bid is already above that); sold with the
//         position (its exit minute and bid). K = 0%, 10% (the thesis), 25%. A buy: counts toward the 15 a day,
//         not a new position slot (max open), not a stock's 2 trades. No book at t: no add (counted).
//   B 10  take the new alert's own trade (its contract, buy, exit) at half the normal size (floor, at least 1),
//         instead of refusing it as busy. Counts toward the 15 a day and max open (it is a position); not a
//         stock's 2 trades; it keeps the stock busy until its own sale.
// Fees $0.62 a contract each way. Tune = even ISO entry weeks, check = odd; every half's account from $100K.
//
//   node --import tsx scripts/.addlab.ts <d1.sqlite> <outDir>      (reads <outDir>/parts, writes <outDir>/addlab.json)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";
import { D1OptionQuotes } from "../packages/market-data/src/option-quotes.js";
import { savedMinutes } from "../packages/market-data/src/volume-backtest.js";
import { D1VolumeData } from "../packages/market-data/src/volume-data.js";
import { bookAt } from "../packages/trading/src/bot/backtest.js";
import {
  tradeReturn,
  volumeAccount,
  type VolumeSignal,
  type VolumeStockRun,
} from "../packages/trading/src/strangle/backtest.js";

const [dbPath, outDir] = process.argv.slice(2);
const db = new SqliteD1(dbPath!);
const store = new D1VolumeData(db);
const quotes = new D1OptionQuotes(db);
const fee = 0.62;

const runs: VolumeStockRun[] = [];
const bySym = new Map<string, VolumeStockRun>();
for (const f of readdirSync(join(outDir!, "parts")).sort()) {
  const r = JSON.parse(readFileSync(join(outDir!, "parts", f), "utf8")) as VolumeStockRun;
  let run = bySym.get(r.symbol);
  if (!run) {
    run = { symbol: r.symbol, signals: [], ignored: r.ignored };
    bySym.set(r.symbol, run);
    runs.push(run);
  }
  run.signals.push(...r.signals);
}

// ---- the open leg's book at the add second ----

interface Book { bid: number; ask: number; src: "seconds" | "minutes" }
const minuteCache = new Map<string, Awaited<ReturnType<typeof savedMinutes>>>();
async function minutesOf(contract: string, date: string) {
  const key = `${contract}|${date}`;
  const hit = minuteCache.get(key);
  if (hit) return hit;
  const day = (await quotes.get(contract, date, date)).get(date) ?? [];
  const saved = savedMinutes(await store.option(contract, date, 0, 390 * 60).catch(() => []));
  const have = new Set(day.map((q) => q.m));
  const merged = [...day, ...saved.filter((q) => !have.has(q.m))].sort((a, b) => a.m - b.m);
  minuteCache.set(key, merged);
  return merged;
}
function newestAt<T extends { s: number }>(rows: readonly T[], s: number): T | null {
  let best: T | null = null;
  for (const r of rows) if (r.s <= s) best = r;
  return best;
}
/** The engine's buy (priceBuy, strict on seconds, then the minute book): the book at t, the price paid. */
async function bookAndBuy(contract: string, date: string, t: number): Promise<{ book: Book; buy: number } | null> {
  const rows = (await store.option(contract, date, t - 4, t + 10).catch(() => [])).filter((r) => r.bid > 0 && r.ask > 0);
  let q: { bid: number; ask: number } | null = null;
  let later: { bid: number; ask: number } | null = null;
  let src: Book["src"] = "seconds";
  if (rows.length) {
    q = newestAt(rows, t);
    later = newestAt(rows, t + 10);
  }
  if (!q) {
    const day = await minutesOf(contract, date);
    const m = Math.floor(t / 60) - 1;
    const b = bookAt(day, m);
    if (b && b.bid > 0 && b.ask > 0) {
      q = b;
      const l = bookAt(day, m + 1);
      later = l && l.bid > 0 ? l : null;
      src = "minutes";
    }
  }
  if (!q) return null;
  const mid = (q.bid + q.ask) / 2;
  let buy = mid + (q.ask - mid) / 2;
  if (later && later.bid > buy) buy = later.ask;
  return { book: { bid: q.bid, ask: q.ask, src }, buy };
}

// ---- the add events (before the account) ----

interface AddEvent {
  parent: VolumeSignal;
  alert: VolumeSignal;
  t: number; // the add's second
  minute: number; // the add's buy minute (the alert's trade buyMinute)
  gain: number; // the open leg's bid / its buy - 1
  addBuy: number; // A: the open contract's price paid
  src: string;
}
interface Stats { busySame: number; busyOther: number; noBook: number; under: number; events: number; bySrc: Record<string, number> }

/** The stock-days' kept trades (the engine's busy rule), with each variant's add events. */
async function plan(variant: "base" | "A" | "B", K: number) {
  const byStockDay = new Map<string, VolumeSignal[]>();
  for (const r of runs)
    for (const sig of r.signals) {
      if (!sig.trade) continue;
      const key = `${sig.date}|${sig.symbol}`;
      let list = byStockDay.get(key);
      if (!list) byStockDay.set(key, (list = []));
      list.push(sig);
    }
  const kept: VolumeSignal[] = [];
  const adds: AddEvent[] = [];
  const st: Stats = { busySame: 0, busyOther: 0, noBook: 0, under: 0, events: 0, bySrc: {} };
  for (const list of byStockDay.values()) {
    let busyTo = -1;
    let n = 0;
    let parent: VolumeSignal | null = null;
    let used = false;
    for (const sig of list.sort((a, b) => a.second - b.second)) {
      const t = sig.trade!;
      if (t.buyMinute <= busyTo) {
        if (variant === "base" || !parent || used) continue;
        const p = parent.trade!;
        if (t.right !== p.right) { st.busyOther++; continue; }
        const at = t.sideSecond + 2;
        if (at <= p.sideSecond + 2 || t.buyMinute >= p.exitMinute) continue;
        st.busySame++;
        const got = await bookAndBuy(p.contract, sig.date, at);
        if (!got) { st.noBook++; continue; }
        const gain = got.book.bid / p.buy - 1;
        if (gain < K) { st.under++; continue; }
        used = true;
        st.events++;
        st.bySrc[got.book.src] = (st.bySrc[got.book.src] ?? 0) + 1;
        adds.push({ parent, alert: sig, t: at, minute: t.buyMinute, gain, addBuy: got.buy, src: got.book.src });
        if (variant === "B") busyTo = Math.max(busyTo, t.exitMinute);
        continue;
      }
      if (n >= 2) continue;
      kept.push(sig);
      busyTo = t.exitMinute;
      parent = sig;
      used = false;
      n++;
    }
  }
  return { kept, adds, st };
}

// ---- the account (volumeAccount's steps, with the adds) ----

interface Row {
  id: string;
  kind: "trade" | "add";
  sym: string;
  date: string;
  buyMinute: number;
  exit: number;
  qty: number;
  pnl: number;
  ret: number;
  label: string;
}
interface Money { sizePct: number; maxTradesPerDay: number; maxOpen: number; dayLossPct: number }
const live: Omit<Money, "sizePct"> = { maxTradesPerDay: 15, maxOpen: 5, dayLossPct: 7.5 };

function account(kept: VolumeSignal[], adds: AddEvent[], variant: string, sizePct: number, skip: Set<string> = new Set()) {
  type Ev = { kind: "trade"; sig: VolumeSignal } | { kind: "add"; ev: AddEvent };
  const byDay = new Map<string, Ev[]>();
  const push = (date: string, e: Ev) => {
    let l = byDay.get(date);
    if (!l) byDay.set(date, (l = []));
    l.push(e);
  };
  for (const s of kept) if (!skip.has(s.id)) push(s.date, { kind: "trade", sig: s });
  for (const a of adds) if (!skip.has(`add:${a.alert.id}`) && !skip.has(a.parent.id)) push(a.parent.date, { kind: "add", ev: a });
  let equity = 100_000;
  let peak = equity;
  let drop = 0;
  const rows: Row[] = [];
  for (const date of [...byDay.keys()].sort()) {
    const start = equity;
    const evs = byDay.get(date)!;
    const minuteOf = (e: Ev) => (e.kind === "trade" ? e.sig.trade!.buyMinute : e.ev.minute);
    const alertMin = (e: Ev) => (e.kind === "trade" ? e.sig.minute : e.ev.alert.minute);
    evs.sort((a, b) => minuteOf(a) - minuteOf(b) || alertMin(a) - alertMin(b));
    const done: { exit: number; pnl: number; slot: boolean }[] = [];
    const takenQty = new Map<string, number>();
    const day: Row[] = [];
    for (const e of evs) {
      const at = minuteOf(e);
      const isA = e.kind === "add" && variant === "A";
      if (isA && !takenQty.has(e.ev.parent.id)) continue; // the parent was refused: nothing to add to
      if (e.kind === "add" && variant === "B" && !takenQty.has(e.ev.parent.id)) continue;
      const closed = done.filter((d) => d.exit < at).reduce((s, d) => s + d.pnl, 0);
      if (closed <= (-live.dayLossPct / 100) * start) continue;
      if (done.length >= live.maxTradesPerDay) continue;
      if (!isA && done.filter((d) => d.slot && d.exit >= at).length >= live.maxOpen) continue;
      if (e.kind === "trade") {
        const t = e.sig.trade!;
        const qty = Math.floor(((sizePct / 100) * start) / (t.buy * 100));
        if (qty < 1) continue;
        const pnl = qty * (t.sell - t.buy) * 100 - fee * 2 * qty;
        done.push({ exit: t.exitMinute, pnl, slot: true });
        takenQty.set(e.sig.id, qty);
        day.push({ id: e.sig.id, kind: "trade", sym: e.sig.symbol, date, buyMinute: t.buyMinute, exit: t.exitMinute, qty, pnl,
          ret: tradeReturn(t, fee), label: `${e.sig.symbol} ${date} ${e.sig.kind} ${t.contract}` });
        continue;
      }
      const a = e.ev;
      const p = a.parent.trade!;
      if (variant === "A") {
        const qty = Math.max(1, Math.floor(takenQty.get(a.parent.id)! / 2));
        const pnl = qty * (p.sell - a.addBuy) * 100 - fee * 2 * qty;
        done.push({ exit: p.exitMinute, pnl, slot: false });
        day.push({ id: `add:${a.alert.id}`, kind: "add", sym: a.parent.symbol, date, buyMinute: a.minute, exit: p.exitMinute, qty, pnl,
          ret: (p.sell * 100 - fee) / (a.addBuy * 100 + fee) - 1,
          label: `${a.parent.symbol} ${date} add ${p.contract} at +${(a.gain * 100).toFixed(0)}% (${a.alert.kind})` });
      } else {
        const t = a.alert.trade!;
        const full = Math.floor(((sizePct / 100) * start) / (t.buy * 100));
        if (full < 1) continue;
        const qty = Math.max(1, Math.floor(full / 2));
        const pnl = qty * (t.sell - t.buy) * 100 - fee * 2 * qty;
        done.push({ exit: t.exitMinute, pnl, slot: true });
        day.push({ id: `add:${a.alert.id}`, kind: "add", sym: a.alert.symbol, date, buyMinute: t.buyMinute, exit: t.exitMinute, qty, pnl,
          ret: tradeReturn(t, fee), label: `${a.alert.symbol} ${date} own ${a.alert.kind} ${t.contract} (open +${(a.gain * 100).toFixed(0)}%)` });
      }
    }
    for (const r of [...day].sort((x, y) => x.exit - y.exit)) {
      equity += r.pnl;
      peak = Math.max(peak, equity);
      drop = Math.max(drop, 1 - equity / peak);
    }
    rows.push(...day);
  }
  return { end: equity, drop: drop * 100, rows };
}

// ---- the report ----

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
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  if (s.length % 2) return s[m]!;
  return (s[m - 1]! + s[m]!) / 2;
};
const k = (x: number) => `${x < 0 ? "-" : ""}$${(Math.abs(x) / 1000).toFixed(1)}K`;
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;

function figures(kept: VolumeSignal[], adds: AddEvent[], variant: string) {
  const r2 = account(kept, adds, variant, 2);
  const r3 = account(kept, adds, variant, 3);
  const best5 = [...r2.rows].sort((a, b) => b.pnl - a.pnl).slice(0, 5).map((r) => r.id);
  const wo = account(kept, adds, variant, 2, new Set(best5));
  const flat = (r: Row) => (r.kind === "add" ? 1000 : 2000);
  const nonGiant = r2.rows.filter((r) => r.ret < 3).reduce((s, r) => s + r.ret * flat(r), 0);
  const giants = r2.rows.filter((r) => r.ret >= 3).length;
  const byYear = (y: string) => r2.rows.filter((r) => r.date.startsWith(y)).reduce((s, r) => s + r.pnl, 0);
  const addRows = r2.rows.filter((r) => r.kind === "add");
  const addBest5 = new Set([...addRows].sort((a, b) => b.pnl - a.pnl).slice(0, 5).map((r) => r.id));
  return {
    trades: r2.rows.filter((r) => r.kind === "trade").length,
    adds: addRows.length,
    won: r2.rows.filter((r) => r.pnl > 0).length,
    median: median(r2.rows.map((r) => r.ret)),
    end2: r2.end, drop2: r2.drop, end3: r3.end, drop3: r3.drop,
    wo5: wo.end - 100_000,
    nonGiant, giants,
    y2025: byYear("2025"), y2026: byYear("2026"),
    addSum: addRows.reduce((s, r) => s + r.pnl, 0),
    addMedian: median(addRows.map((r) => r.ret)),
    addWon: addRows.filter((r) => r.pnl > 0).length,
    addWo5: addRows.filter((r) => !addBest5.has(r.id)).reduce((s, r) => s + r.pnl, 0),
    addBest: [...addRows].sort((a, b) => b.pnl - a.pnl).slice(0, 3).map((r) => `${r.label} ${pct(r.ret)} ${k(r.pnl)}`),
    addWorst: [...addRows].sort((a, b) => a.pnl - b.pnl).slice(0, 3).map((r) => `${r.label} ${pct(r.ret)} ${k(r.pnl)}`),
    best5: [...r2.rows].sort((a, b) => b.pnl - a.pnl).slice(0, 5).map((r) => `${r.label} ${pct(r.ret)}`),
    rows: r2.rows,
  };
}
type Fig = ReturnType<typeof figures>;
const line = (name: string, f: Fig) =>
  `| ${name} | ${f.trades} | ${f.adds} | ${f.won} | ${pct(f.median)} | ${k(f.end2)} (${f.drop2.toFixed(0)}%) | ${k(f.end3)} (${f.drop3.toFixed(0)}%) | ${k(f.wo5)} | ${k(f.nonGiant)} | ${f.giants} | ${k(f.y2025)} / ${k(f.y2026)} |`;
const head =
  "| Version | Trades | Adds | Winners | Median | 2% (worst drop) | 3% (worst drop) | Without the best 5 | Non-giant sum | Giants | 2025 / 2026 |\n|---|---|---|---|---|---|---|---|---|---|---|";

// The engine's own account must be reproduced with no adds.
const eng2 = volumeAccount(runs, { start: 100_000, sizePct: 2, feePerContract: fee, maxPerStock: 2, limits: true, maxTradesPerDay: 15, maxOpen: 5, dayLossPct: 7.5 });
const eng3 = volumeAccount(runs, { start: 100_000, sizePct: 3, feePerContract: fee, maxPerStock: 2, limits: true, maxTradesPerDay: 15, maxOpen: 5, dayLossPct: 7.5 });
const counts: Record<string, number> = {};
for (const r of runs) for (const s of r.signals) counts[s.outcome] = (counts[s.outcome] ?? 0) + 1;
console.log(`alerts ${runs.reduce((s, r) => s + r.signals.length, 0)}`, JSON.stringify(counts));
console.log(`engine account (year): 2% $${Math.round(eng2.end)} drop ${eng2.maxDrawdownPct.toFixed(1)}% taken ${eng2.taken} won ${eng2.won}; 3% $${Math.round(eng3.end)} drop ${eng3.maxDrawdownPct.toFixed(1)}%`);
const refused: Record<string, number> = {};
for (const x of eng2.trades) refused[x.status] = (refused[x.status] ?? 0) + 1;
console.log("account statuses (2%):", JSON.stringify(refused));

const variants: { name: string; v: "base" | "A" | "B"; K: number }[] = [
  { name: "1.3.0 (base)", v: "base", K: 0 },
  { name: "A K 0%", v: "A", K: 0 },
  { name: "A K 10% (thesis)", v: "A", K: 0.1 },
  { name: "A K 25%", v: "A", K: 0.25 },
  { name: "B K 10%", v: "B", K: 0.1 },
];
const out: Record<string, unknown> = {};
const planned = new Map<string, Awaited<ReturnType<typeof plan>>>();
for (const x of variants) planned.set(x.name, await plan(x.v, x.K));
const half = (p: Awaited<ReturnType<typeof plan>>, h: string | null) => ({
  kept: p.kept.filter((s) => !h || halfOf(s.date) === h),
  adds: p.adds.filter((a) => !h || halfOf(a.parent.date) === h),
});

const yearBase = figures(planned.get("1.3.0 (base)")!.kept, [], "base");
console.log(`\nmy re-walk, year, base: 2% ${k(yearBase.end2)} (${yearBase.drop2.toFixed(1)}%) trades ${yearBase.trades}; 3% ${k(yearBase.end3)} (${yearBase.drop3.toFixed(1)}%)`);

console.log("\nAdd events (year, before the account): same-right busy alerts in the open window / no book / under K / events / by book");
for (const x of variants.slice(1)) {
  const st = planned.get(x.name)!.st;
  console.log(`${x.name}: ${st.busySame} / ${st.noBook} / ${st.under} / ${st.events} / ${JSON.stringify(st.bySrc)} (other-right busy ${st.busyOther})`);
}

const figs: Record<string, Record<string, Fig>> = {};
for (const h of ["tune", "check", "year"]) {
  figs[h] = {};
  for (const x of variants) {
    const p = half(planned.get(x.name)!, h === "year" ? null : h);
    figs[h]![x.name] = figures(p.kept, p.adds, x.v);
  }
}
console.log("\n## Tune (even ISO entry weeks)\n" + head);
for (const x of variants) console.log(line(x.name, figs.tune![x.name]!));
// The pick of each idea on tune: the most money at 2%, at the same or smaller drop than... (judged in words);
// here the most 2% money among A's levels; B has one level.
const aNames = variants.filter((x) => x.v === "A").map((x) => x.name);
const pickA = aNames.reduce((b, n) => (figs.tune![n]!.end2 > figs.tune![b]!.end2 ? n : b), aNames[0]!);
const picks = ["1.3.0 (base)", pickA, "B K 10%"];
console.log(`\n🎯 pick A: ${pickA}; 🎯 pick B: B K 10%`);
console.log("\n## Check (odd ISO entry weeks), base and the picks\n" + head);
for (const n of picks) console.log(line(n, figs.check![n]!));
console.log("\n## Year (one account), base and the picks\n" + head);
for (const n of picks) console.log(line(n, figs.year![n]!));

console.log("\n## The adds alone, 2% (sum / median / winners / sum without their best 5)");
for (const h of ["tune", "check", "year"])
  for (const x of variants.slice(1)) {
    const f = figs[h]![x.name]!;
    console.log(`${h} ${x.name}: ${f.adds} adds, sum ${k(f.addSum)}, median ${pct(f.addMedian)}, won ${f.addWon}, w/o best 5 ${k(f.addWo5)}`);
  }
for (const x of variants.slice(1)) {
  const f = figs.year![x.name]!;
  console.log(`\n${x.name} best adds: ${f.addBest.join("; ")}\n${x.name} worst adds: ${f.addWorst.join("; ")}`);
}
console.log(`\nbase best 5 (year): ${figs.year!["1.3.0 (base)"]!.best5.join("; ")}`);

for (const h of Object.keys(figs))
  for (const n of Object.keys(figs[h]!)) {
    const { rows, ...rest } = figs[h]![n]!;
    out[`${h}|${n}`] = { ...rest, rows: rows.map((r) => ({ ...r })) };
  }
out.events = Object.fromEntries(
  variants.slice(1).map((x) => [x.name, planned.get(x.name)!.adds.map((a) => ({
    sym: a.parent.symbol, date: a.parent.date, parent: a.parent.trade!.contract, parentKind: a.parent.kind,
    parentBuy: a.parent.trade!.buy, parentSell: a.parent.trade!.sell, alert: a.alert.id, alertKind: a.alert.kind,
    t: a.t, gain: a.gain, addBuy: a.addBuy, src: a.src, ownContract: a.alert.trade!.contract,
    ownBuy: a.alert.trade!.buy, ownSell: a.alert.trade!.sell, half: halfOf(a.parent.date),
  }))]),
);
writeFileSync(join(outDir!, "addlab.json"), JSON.stringify(out));
