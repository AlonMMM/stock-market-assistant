// Checks the bot's exit rules against the Python backtest: every trade of a
// tiers run (e.g. t_flat_n100_<year>) is walked again on its option bars with
// `nextAction`, and the sequence of rules that sold must be the backtest's.
//
//   node --import tsx scripts/bot-exit-parity.ts <market.sqlite> <run prefix, e.g. data/local/x/bt/t_flat_n100_2025>
//
// Reads the backtest's local cache and results (data/local/x/bt, not in Git).
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closes, type MinuteBar } from "../packages/trading/src/bot/signal.js";
import {
  nextAction,
  type BotPositionState,
  type ExitReason,
} from "../packages/trading/src/bot/exits.js";

const [dbPath, prefix] = process.argv.slice(2);
if (!dbPath || !prefix)
  throw new Error("usage: bot-exit-parity.ts <market.sqlite> <run prefix>");
const db = new DatabaseSync(dbPath, { readOnly: true });
const read = db.prepare("SELECT bars FROM bars WHERE symbol = ? AND date = ?");
const day = (symbol: string, date: string): MinuteBar[] => {
  const row = read.get(symbol, date) as { bars: string } | undefined;
  return (row ? (JSON.parse(row.bars) as number[][]) : []).map(
    ([m, o, h, l, c, v]) => ({ m: m!, o: o!, h: h!, l: l!, c: c!, v: v! }),
  );
};
const calendar = (
  db
    .prepare("SELECT date FROM bars WHERE symbol = 'SPY' ORDER BY date")
    .all() as { date: string }[]
).map((r) => r.date);

const csv = (path: string) => {
  const [head, ...rows] = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const cols = head!.split(",");
  return rows.map(
    (line) =>
      Object.fromEntries(line.split(",").map((v, i) => [cols[i], v])) as Record<
        string,
        string
      >,
  );
};
const dir = dirname(prefix);
const files = readdirSync(dir).filter(
  (f) => f.startsWith(basename(prefix) + ".") && f.endsWith("_trades.csv"),
);

const NAME: Record<string, ExitReason> = {
  U_check10: "check-10",
  U_check20: "check-20",
  U_out: "stop-30",
  eod_close: "close-1550",
  eod_carry: "carry",
  morning_gap_keep: "morning-gap-keep",
  morning_gap_against: "morning-gap-against",
  expiry_day: "expiry-day",
};
const SH = 0.02;
let same = 0,
  differ = 0,
  skipped = 0;
const examples: string[] = [];
for (const f of files) {
  const legs = new Map(
    csv(join(dir, f.replace("_trades.csv", "_legs.csv")))
      .filter((l) => l.leg === "0")
      .map((l) => [l.id, l]),
  );
  for (const t of csv(join(dir, f))) {
    const leg = legs.get(t.id!);
    if (t.status !== "ok" || !leg) continue;
    const want = leg.rules!.split("|").filter(Boolean);
    if (want.some((w) => !(w in NAME))) {
      skipped++;
      continue;
    } // late fills, forced day ends, expiries
    const minute = Number(t.minute);
    const i0 = calendar.indexOf(t.date!);
    const dates = calendar.slice(i0).filter((d) => d <= t.expiry!);
    const p: BotPositionState = {
      right: t.right as "C" | "P",
      qty: 100,
      cost: 0,
      entryMinute: minute,
      entryStock: 0,
      nights: 0,
      checksDone: [],
      morningDone: false,
    };
    const got: ExitReason[] = [];
    let pending = 0;
    walk: for (let k = 0; k < dates.length; k++) {
      const d = dates[k]!;
      const stockBars = day(t.sym!, d);
      const sc = closes(stockBars);
      if (k === 0) p.entryStock = sc[minute]!;
      const prev = day(t.sym!, calendar[calendar.indexOf(d) - 1]!);
      const open = stockBars[0] && stockBars[0].m <= 5 ? stockBars[0].o : null;
      let carryDone = false;
      for (const b of day(t.contract!, d)) {
        if (k === 0 && b.m <= minute) continue;
        if (p.cost === 0) {
          p.cost = ((b.h + b.l) / 2) * (1 + SH);
          continue;
        } // the buy bar
        if (pending) {
          p.qty -= pending;
          pending = 0;
          if (p.qty <= 0) break walk;
        }
        const a = nextAction(
          p,
          {
            minute: b.m,
            stock: sc[Math.min(b.m, 389)] ?? null,
            option: b.c,
            isExpiryDay: d === t.expiry,
            sessionBeforeExpiry: k + 1 < dates.length,
            open,
            prevClose: prev.at(-1)?.c ?? null,
          },
          undefined,
          carryDone,
        );
        Object.assign(p, a.update);
        if (a.reason === "carry" || a.reason === "close-1550") carryDone = true;
        if (a.reason) got.push(a.reason);
        if (a.sell) pending = a.sell;
      }
      if (pending) {
        p.qty -= pending;
        pending = 0;
      }
      if (p.qty <= 0) break;
    }
    const ok = got.join("|") === want.map((w) => NAME[w]).join("|");
    if (ok) same++;
    else {
      differ++;
      if (examples.length < 12)
        examples.push(
          `${t.date} ${t.sym} ${t.contract}: python ${want.join("|")}, ts ${got.join("|")}`,
        );
    }
  }
}
console.log(
  `trades that agree: ${same}, differ: ${differ}, skipped (late/forced/expired): ${skipped}`,
);
for (const e of examples) console.log(e);
