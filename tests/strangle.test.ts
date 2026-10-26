// SYNTHETIC market data, chains and fills: the alert leg bot
// (docs/tasks/backend-strangle-bot.md). The alert, the side, the buy and the
// give-back are also checked against the Python backtest's trades on real bars
// by scripts/strangle-parity.ts (local data only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newYorkToUtc,
  previousSessions,
} from "../packages/market-data/src/calendar.js";
import type { MinuteBar } from "../packages/trading/src/bot/signal.js";
import type { OptionQuote } from "../packages/trading/src/options.js";
import { liquidOrder } from "../packages/trading/src/bot/picker.js";
import {
  alertCloseness,
  alertRule,
  alerts,
  firstAlert,
  measureAt,
  windows,
} from "../packages/trading/src/strangle/alert.js";
import {
  bestOf,
  giveBackExit,
  legQty,
  sideOf,
  strengthAgrees,
  waitedOut,
} from "../packages/trading/src/strangle/decide.js";
import {
  defaultStrangleSettings,
  parseStrangleSettings,
  strangleStocks,
  strangleSteps,
  strangleWithDefaults,
  type StrangleSettings,
} from "../packages/trading/src/strangle/settings.js";
import type { BotMarket, BotTrading } from "../apps/trader/src/bot.js";
import { StrangleBot, strangleTag } from "../apps/trader/src/strangle.js";
import {
  StrangleStore,
  tradeCash,
  type StrangleSignal,
} from "../apps/trader/src/strangle-store.js";

// ---- synthetic bars ----

function session(
  start: number,
  step: (m: number) => number,
  vol: (m: number) => number,
): MinuteBar[] {
  const out: MinuteBar[] = [];
  let p = start;
  for (let m = 0; m < 390; m++) {
    const o = p;
    p = p * (1 + step(m));
    out.push({ m, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: vol(m) });
  }
  return out;
}
const wiggle = (m: number) => (m % 2 ? 0.0004 : -0.0004);
const quietDay = () => session(100, wiggle, () => 1000);
// A burst at 10:08-10:09 New York (minutes 38-39): 20x volume, +0.3% a minute;
// then a steady climb.
const burstDay = (after = 0.001) =>
  session(
    100,
    (m) => (m === 38 || m === 39 ? 0.003 : m > 39 ? after : wiggle(m)),
    (m) => (m === 38 || m === 39 ? 20000 : 1000),
  );

test("alert: a 3-minute burst of 4x volume and 3x the usual move is an alert, the first at 10:09", () => {
  const hist = Array.from({ length: 20 }, () => windows(quietDay()));
  const sides = alerts(burstDay(), hist);
  assert.equal(sides.slice(0, 39).some(Boolean), false);
  assert.equal(sides[39], "up");
  assert.deepEqual(firstAlert(sides, 10, 209), { minute: 39, side: "up" });
  // A quiet day: none; too little history: none.
  assert.equal(alerts(quietDay(), hist).some(Boolean), false);
  assert.equal(alerts(burstDay(), hist.slice(0, 9)).some(Boolean), false);
  // A falling burst is "down".
  const down = session(
    100,
    (m) => (m === 38 || m === 39 ? -0.003 : wiggle(m)),
    (m) => (m === 38 || m === 39 ? 20000 : 1000),
  );
  assert.equal(firstAlert(alerts(down, hist), 10, 209)?.side, "down");
});

test("scan: a bursting stock measures at or over the alert's thresholds and sorts first; quiet stocks below", () => {
  const hist = Array.from({ length: 20 }, () => windows(quietDay()));
  const burst = measureAt(burstDay(), hist, 39)!;
  assert.equal(burst.minute, 39);
  assert.equal(burst.side, "up");
  assert.ok(burst.volRatio >= alertRule.threshold);
  assert.ok(burst.moveRatio >= alertRule.priceMultiple);
  assert.ok(burst.shares >= alertRule.minVolume);
  assert.ok(burst.movePct >= alertRule.minMovePercent);
  const quiet = measureAt(quietDay(), hist, 39)!;
  assert.ok(quiet.volRatio < alertRule.threshold);
  assert.ok(quiet.moveRatio < alertRule.priceMultiple);
  assert.ok(alertCloseness(quiet) < 1);
  assert.ok(alertCloseness(burst) >= 1);
  const rows = [
    { symbol: "QUIET", ...quiet },
    { symbol: "BURST", ...burst },
  ].sort((a, b) => alertCloseness(b) - alertCloseness(a));
  assert.equal(rows[0]!.symbol, "BURST");
  // The same quantities as the alert: wherever it fires, every check is met.
  const day = burstDay();
  const sides = alerts(day, hist);
  for (let m = 0; m < 390; m++) {
    if (!sides[m]) continue;
    const x = measureAt(day, hist, m)!;
    assert.ok(x.volRatio >= alertRule.threshold, `volume at ${m}`);
    assert.ok(x.moveRatio >= alertRule.priceMultiple, `move at ${m}`);
    assert.ok(x.shares >= alertRule.minVolume && x.movePct >= 0.5);
  }
  // Too little history or a missing bar: nothing to measure.
  assert.equal(measureAt(burstDay(), hist.slice(0, 9), 39), null);
  assert.equal(
    measureAt(
      burstDay().filter((b) => b.m !== 37),
      hist,
      39,
    ),
    null,
  );
});

test("decide: the side, the strength filter, the wait, the give-back, the size", () => {
  const s = defaultStrangleSettings;
  // unit 0.4%: the side at 0.1% either way.
  assert.equal(sideOf(100.05, 100, 0.004, s), null);
  assert.equal(sideOf(100.11, 100, 0.004, s), "C");
  assert.equal(sideOf(99.89, 100, 0.004, s), "P");
  assert.equal(strengthAgrees("C", 1.2), true);
  assert.equal(strengthAgrees("C", -0.3), false);
  assert.equal(strengthAgrees("P", null), false);
  // The give-up: 10 minutes after the alert by default.
  assert.equal(waitedOut(49, 40, s), false);
  assert.equal(waitedOut(50, 40, s), true);
  // The give-back: 0.75 x 0.4% = 0.3% from the best, the side's way.
  assert.equal(bestOf(101, 102, "C"), 102);
  assert.equal(bestOf(99, 98, "P"), 98);
  assert.equal(giveBackExit(101.75, 102, "C", 0.004, 200, s), null);
  assert.equal(giveBackExit(101.69, 102, "C", 0.004, 200, s), "giveback");
  assert.equal(giveBackExit(98.25, 98, "P", 0.004, 200, s), null);
  assert.equal(giveBackExit(98.3, 98, "P", 0.004, 200, s), "giveback");
  assert.equal(giveBackExit(110, 110, "C", 0.004, 360, s), "end");
  // 1% of $100,000 at 0.61: 16 contracts.
  assert.equal(legQty(100000, 1, 0.61), 16);
  assert.equal(legQty(1000, 1, 0.61), 0);
});

test("settings: the backtested defaults; bad values refused; the stocks; the rule in words", () => {
  const d = defaultStrangleSettings;
  assert.equal(d.enabled, false);
  assert.equal(d.mode, "dry");
  assert.equal(d.delta, 0.35);
  assert.equal(d.confirmUnits, 0.25);
  assert.equal(d.giveBackUnits, 0.75);
  assert.deepEqual(parseStrangleSettings(d), { ok: true, value: d });
  assert.equal(parseStrangleSettings({ ...d, sizePct: 7 }).ok, false);
  assert.equal(parseStrangleSettings({ ...d, safetyStopPct: 80 }).ok, false);
  assert.equal(parseStrangleSettings({ ...d, maxTradesPerDay: 21 }).ok, false);
  assert.equal(parseStrangleSettings({ ...d, giveBackUnits: 2 }).ok, false);
  assert.equal(parseStrangleSettings({ ...d, lastMinute: 5 }).ok, false);
  assert.equal(parseStrangleSettings({ ...d, mode: "maybe" }).ok, false);
  assert.equal(
    parseStrangleSettings({ ...d, added: ["bad ticker"] }).ok,
    false,
  );
  // Saved values over the defaults; a bad record falls back.
  assert.equal(strangleWithDefaults({ sizePct: 2 }).sizePct, 2);
  assert.equal(strangleWithDefaults({ sizePct: 99 }).sizePct, d.sizePct);
  assert.deepEqual(
    strangleStocks({ ...d, added: ["AAA"], off: ["BBB"] }, [
      "BBB",
      "CCC",
      "SPY",
    ]),
    ["AAA", "CCC"],
  );
  assert.deepEqual(
    strangleStocks({ ...d, followFavorites: false, added: ["AAA"] }, ["CCC"]),
    ["AAA"],
  );
  const steps = strangleSteps(d).map((x) => x.name);
  assert.deepEqual(steps, [
    "The alert",
    "News filter",
    "The side",
    "Buy",
    "Sell",
    "Limits",
  ]);
});

// ---- the runner ----

const DAY = "2026-10-23"; // a Friday session, with a same-day expiry
const at = (date: string, wall: number, sec = 20) =>
  newYorkToUtc(date, wall) + sec * 1000;
const q = (
  right: "call" | "put",
  strike: number,
  delta: number,
  bid: number,
  expiry = DAY,
): OptionQuote => ({
  symbol: `NVDA${expiry.slice(2).replaceAll("-", "")}${right === "call" ? "C" : "P"}${String(strike * 1000).padStart(8, "0")}`,
  underlying: "NVDA",
  expiry,
  right,
  strike,
  bid,
  ask: bid + 0.02,
  delta: right === "call" ? delta : -delta,
});

function harness(
  settings: Partial<StrangleSettings>,
  opts: {
    day?: MinuteBar[];
    expiry?: string;
    // contracts each leg traded in the last 30 minutes; 500 when not given
    volume?: (contract: string) => number;
  } = {},
) {
  const store = new StrangleStore(
    join(mkdtempSync(join(tmpdir(), "strangle-")), "t.sqlite"),
  );
  store.setSetting(
    "settings",
    JSON.stringify({
      ...defaultStrangleSettings,
      enabled: true,
      added: ["NVDA"],
      followFavorites: false,
      ...settings,
    }),
  );
  const days = previousSessions(DAY, 20);
  const today = opts.day ?? burstDay();
  const market: BotMarket = {
    async sessions(symbols, dates) {
      return new Map(
        symbols.map((s) => [
          s,
          new Map(
            dates.map((d) => [
              d,
              s === "SPY" ? session(500, wiggle, () => 50000) : quietDay(),
            ]),
          ),
        ]),
      );
    },
    async bars(symbols, date, from, to) {
      return new Map(
        symbols.map((s) => [
          s,
          (s === "SPY" ? session(500, wiggle, () => 50000) : today).filter(
            (b) => date === DAY && b.m >= from && b.m <= to,
          ),
        ]),
      );
    },
    async optionVolume30(contract) {
      return opts.volume?.(contract) ?? 500;
    },
  };
  void days;
  const mids = { C: 0.6, P: 0.5 };
  const held = new Map<string, number>();
  const jobs = new Map<string, { state: string; result: unknown }>();
  const calls: { kind: string; body: Record<string, unknown> }[] = [];
  const notes: string[] = [];
  const isCall = (c: string) => /C\d{8}$/.test(c);
  const trading: BotTrading = {
    async chain(_u, right, from, to) {
      const e = opts.expiry ?? DAY;
      const all =
        right === "call"
          ? [
              q("call", 101, 0.35, 0.59, e),
              q("call", 102, 0.28, 0.42, e),
              q("call", 103, 0.2, 0.3, e),
            ]
          : [
              q("put", 99, 0.36, 0.49, e),
              q("put", 98, 0.28, 0.35, e),
              q("put", 97, 0.2, 0.25, e),
            ];
      return all.filter((x) => x.expiry >= from && x.expiry <= to);
    },
    async quote(c) {
      const mid = isCall(c) ? mids.C : mids.P;
      return {
        ...q(isCall(c) ? "call" : "put", 100, 0.35, mid - 0.01),
        symbol: c,
        ask: mid + 0.01,
      };
    },
    async held(c) {
      const n = held.get(c) ?? 0;
      return n > 0 ? { qty: n, avgEntryPrice: isCall(c) ? 0.6 : 0.5 } : null;
    },
    async equity() {
      return 100000;
    },
    async buy(body) {
      calls.push({ kind: "buy", body });
      const c = String(body.contract);
      held.set(c, (held.get(c) ?? 0) + Number(body.qty));
      const id = `b${calls.length}`;
      jobs.set(id, {
        state: "done",
        result: { result: { price: isCall(c) ? mids.C : mids.P } },
      });
      return { status: "started", jobId: id, qty: Number(body.qty) };
    },
    async sell(body) {
      calls.push({ kind: "sell", body });
      const c = String(body.contract);
      const n = Number(body.qty);
      held.set(c, (held.get(c) ?? 0) - n);
      const id = `s${calls.length}`;
      jobs.set(id, {
        state: "done",
        result: { result: { sold: n, price: isCall(c) ? mids.C : mids.P } },
      });
      return { status: "started", jobId: id };
    },
    job(id) {
      return jobs.get(id)!;
    },
  };
  let now = at(DAY, 560);
  const bot = new StrangleBot({
    store,
    market,
    trading,
    account: "owner-strangle",
    now: () => now,
    notify: async (title, lines) => {
      notes.push([title, ...lines].join(" | "));
    },
  });
  const run = async (from: number, to: number) => {
    for (let w = from; w <= to; w++) {
      now = at(DAY, w);
      await bot.tick();
    }
  };
  return { bot, store, run, calls, notes, held, mids };
}

// The burst at 10:08-10:09, a climb to 10:29, then a fall.
const climbThenFall = () =>
  session(
    100,
    (m) =>
      m === 38 || m === 39
        ? 0.003
        : m >= 40 && m < 60
          ? 0.001
          : m >= 60
            ? -0.001
            : wiggle(m),
    (m) => (m === 38 || m === 39 ? 20000 : 1000),
  );

test("runner (dry): first alert -> watching -> the side -> only that leg -> sold on the stock's give-back", async () => {
  const h = harness({ mode: "dry" }, { day: climbThenFall() });
  await h.run(565, 610); // the alert at 10:09 is read at 10:10
  const [sig] = h.store.signals(DAY);
  assert.equal(sig!.minute, 39);
  assert.equal(sig!.outcome, "watching");
  let [t] = h.store.openTrades();
  assert.equal(t!.phase, "watching");
  assert.equal(t!.leg, null);
  // The status: the scan of the last closed minute, the watching trade's price and path.
  const st = h.bot.status();
  assert.equal(st.scan[0]!.symbol, "NVDA");
  assert.equal(st.scan[0]!.minute, 39);
  assert.ok(st.scan[0]!.volRatio >= 4 && st.scan[0]!.moveRatio >= 3);
  assert.equal(st.open[0]!.phase, "watching");
  assert.ok(st.open[0]!.marks!.stock! > 0);
  assert.equal(st.open[0]!.path![0]![0], 39);
  assert.deepEqual(st.live, []);
  // The stock keeps climbing: the side is the call; 1% of $100,000 at the 0.61 ask: 16.
  await h.run(611, 612);
  [t] = h.store.openTrades();
  assert.equal(t!.phase, "open");
  assert.equal(t!.side, "C");
  assert.equal(t!.leg!.contract, "NVDA261023C00101000");
  assert.equal(t!.leg!.qty, 16);
  assert.equal(h.store.signal(DAY, "NVDA")!.outcome, "would-trade");
  // Still climbing to 10:29: held. From 10:30 it falls: sold once it gives back 0.75 of its 30-minute move.
  h.mids.C = 1.2;
  await h.run(613, 629);
  assert.equal(h.store.openTrades().length, 1);
  await h.run(630, 640);
  assert.equal(h.store.openTrades().length, 0);
  const [done] = h.store.recentTrades(DAY);
  assert.equal(done!.phase, "closed");
  assert.match(done!.closeReason ?? "", /gave back 0.75/);
  const cash = tradeCash(done!);
  // Paid 16 x 0.61 = $976; got 16 x 1.20 = $1,920.
  assert.equal(Math.round(cash.paid), 976);
  assert.equal(Math.round(cash.got), 1920);
  assert.equal(h.calls.length, 0);
  assert.ok(
    h.notes.some((n) => n.startsWith(`${strangleTag} (dry run): would buy`)),
  );
  assert.ok(
    h.notes.some((n) => n.startsWith(`${strangleTag} (dry run): would sell`)),
  );
});

test("runner (live): one buy with the tag and the safety stop; one sale of all of it; never short", async () => {
  const h = harness({ mode: "live" }, { day: climbThenFall() });
  await h.run(565, 612);
  const buys = h.calls.filter((c) => c.kind === "buy");
  assert.equal(buys.length, 1);
  assert.equal(buys[0]!.body.contract, "NVDA261023C00101000");
  assert.equal(buys[0]!.body.qty, 16);
  assert.equal(buys[0]!.body.stopPct, 70);
  assert.equal(buys[0]!.body.tag, strangleTag);
  await h.run(613, 614);
  assert.equal(h.store.openTrades()[0]!.phase, "open");
  h.mids.C = 1.2;
  await h.run(615, 645);
  const sells = h.calls.filter((c) => c.kind === "sell");
  assert.equal(sells.length, 1);
  assert.equal(sells[0]!.body.qty, "16");
  assert.equal(h.held.get("NVDA261023C00101000"), 0);
  assert.equal(h.store.openTrades().length, 0);
  for (const [, n] of h.held) assert.ok(n >= 0, "never short");
  // The live result by day, for the benchmark page.
  const [liveDay] = h.bot.status().live;
  assert.equal(liveDay!.day, DAY);
  assert.equal(liveDay!.trades, 1);
  assert.equal(liveDay!.winners, 1);
  assert.ok(liveDay!.pnl > 0);
  // The bid / ask is kept on the signal and on the buy and the sale (paper fills are not real ones).
  const book = h.store.signal(DAY, "NVDA")!.book;
  assert.equal(book?.contract, "NVDA261023C00101000");
  assert.equal(book?.broker, "alpaca");
  assert.ok(book!.ask > book!.bid);
  const orders = h.store.recentTrades(DAY)[0]!.leg!.orders;
  assert.deepEqual(
    orders.map((o) => [o.side, o.book !== undefined]),
    [
      ["buy", true],
      ["sell", true],
    ],
  );
});

test("runner: no side within 10 minutes is no trade; one burst is one alert; off means nothing", async () => {
  const flat = session(
    100,
    (m) => (m === 38 || m === 39 ? 0.003 : 0),
    (m) => (m === 38 || m === 39 ? 20000 : 1000),
  );
  const h = harness({ mode: "dry" }, { day: flat });
  await h.run(565, 611);
  assert.equal(h.store.openTrades()[0]!.phase, "watching");
  await h.run(612, 671);
  assert.equal(h.store.openTrades().length, 0);
  assert.equal(h.store.signal(DAY, "NVDA")!.outcome, "no_side");
  assert.equal(h.store.signals(DAY).length, 1);
  assert.equal(h.calls.length, 0);
  const off = harness({ mode: "dry", enabled: false });
  await off.run(565, 640);
  assert.equal(off.store.signals(DAY).length, 0);
});

test("runner (dry): a 1DTE day buys the next session's leg, and nextDay off skips it", async () => {
  const NEXT = "2026-10-26"; // the Monday after DAY: no same-day expiry, the nearest is the next session
  const h = harness({ mode: "dry" }, { day: climbThenFall(), expiry: NEXT });
  await h.run(565, 612);
  const [t] = h.store.openTrades();
  assert.equal(t!.expiry, NEXT);
  assert.equal(t!.phase, "open");
  assert.equal(t!.leg!.contract, "NVDA261026C00101000");
  assert.equal(h.store.signal(DAY, "NVDA")!.outcome, "would-trade");
  // Sold the same day like a 0DTE leg: by the end of the day nothing is open.
  await h.run(613, 935);
  assert.equal(h.store.openTrades().length, 0);

  const off = harness(
    { mode: "dry", nextDay: false },
    { day: climbThenFall(), expiry: NEXT },
  );
  await off.run(565, 612);
  assert.equal(off.store.openTrades().length, 0);
  assert.equal(off.store.signal(DAY, "NVDA")!.outcome, "no_expiry");
});

// Three bursts on one stock (10:08, 11:30, 12:30 New York), each followed by
// a short climb and a fall that sells the call on the give-back.
const threeBursts = () => {
  const bursts = [38, 120, 180];
  const step = (m: number) => {
    for (const b of bursts) {
      if (m === b || m === b + 1) return 0.003;
      if (m > b + 1 && m <= b + 16) return 0.001;
      if (m > b + 16 && m <= b + 40) return -0.001;
    }
    return wiggle(m);
  };
  const vol = (m: number) =>
    bursts.some((b) => m === b || m === b + 1) ? 20000 : 1000;
  return session(100, step, vol);
};
const bought = (h: ReturnType<typeof harness>) =>
  h.store.recentTrades(DAY).filter((t) => t.leg && t.leg.bought > 0).length;

test("runner (dry): a later burst trades again once the stock is flat, up to maxPerStock a day", async () => {
  const two = harness({ mode: "dry" }, { day: threeBursts() });
  await two.run(565, 960);
  assert.equal(bought(two), 2);
  assert.deepEqual(
    two.store.signals(DAY).map((x) => x.minute),
    [39, 121],
  );
  assert.equal(two.store.openTrades().length, 0);

  const three = harness(
    { mode: "dry", maxPerStock: 3 },
    { day: threeBursts() },
  );
  await three.run(565, 960);
  assert.equal(bought(three), 3);

  const one = harness({ mode: "dry", maxPerStock: 1 }, { day: threeBursts() });
  await one.run(565, 960);
  assert.equal(bought(one), 1);
});

test("runner (dry): a burst while the stock's trade is open is not a new alert", async () => {
  // The second burst comes during the first trade's climb: it is skipped.
  const day = session(
    100,
    (m) => {
      if (m === 38 || m === 39 || m === 48 || m === 49) return 0.003;
      if (m > 39 && m <= 60) return 0.001;
      if (m > 60 && m <= 90) return -0.001;
      return wiggle(m);
    },
    (m) => ([38, 39, 48, 49].includes(m) ? 20000 : 1000),
  );
  const h = harness({ mode: "dry" }, { day });
  await h.run(565, 960);
  assert.deepEqual(
    h.store.signals(DAY).map((x) => x.minute),
    [39],
  );
  assert.equal(bought(h), 1);
});

test("store: the one-a-day signals of before re-entry are copied to the alerts table once", () => {
  const path = join(mkdtempSync(join(tmpdir(), "strangle-")), "old.sqlite");
  const old = new DatabaseSync(path);
  old.exec(
    "CREATE TABLE strangle_signals (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, symbol TEXT NOT NULL, data TEXT NOT NULL, UNIQUE (day, symbol))",
  );
  const sig: StrangleSignal = {
    day: DAY,
    symbol: "NVDA",
    minute: 39,
    side: "up",
    outcome: "traded",
    detail: "",
    at: 1,
  };
  old
    .prepare(
      "INSERT INTO strangle_signals (day, symbol, data) VALUES (?, ?, ?)",
    )
    .run(DAY, "NVDA", JSON.stringify(sig));
  old.close();
  const store = new StrangleStore(path);
  assert.deepEqual(store.signals(DAY), [sig]);
  // A later burst of the same stock is its own row; updates go to the latest.
  assert.equal(store.addSignal({ ...sig, minute: 121, outcome: "" }), true);
  assert.equal(store.addSignal({ ...sig, minute: 121, outcome: "" }), false);
  store.updateSignal(DAY, "NVDA", "no_side", "");
  assert.deepEqual(
    store.signals(DAY).map((x) => [x.minute, x.outcome]),
    [
      [39, "traded"],
      [121, "no_side"],
    ],
  );
  store.close();
  // Opened again: not copied twice.
  assert.equal(new StrangleStore(path).signals(DAY).length, 2);
});

test("runner (dry): a thin leg takes the liquid fallback's strike, or no trade with it off", async () => {
  const thin = (c: string) => (c.endsWith("C00101000") ? 90 : 500);
  const h = harness({ mode: "dry" }, { day: climbThenFall(), volume: thin });
  await h.run(565, 612);
  const [t] = h.store.openTrades();
  // The 0.35 call traded 90: the next strike out, 0.28, trades enough.
  assert.equal(t!.leg!.contract, "NVDA261023C00102000");
  assert.ok(h.notes.some((n) => /liquid fallback/.test(n)));
  const off = harness(
    { mode: "dry", liquidFallback: false },
    { day: climbThenFall(), volume: thin },
  );
  await off.run(565, 612);
  assert.equal(off.store.openTrades().length, 0);
  assert.equal(off.store.signal(DAY, "NVDA")!.outcome, "thin");
});

test("liquid order: further out first, nearest the target first, then toward the money", () => {
  const e = DAY;
  const chain = [
    q("call", 100, 0.48, 1.1, e),
    q("call", 101, 0.35, 0.59, e),
    q("call", 102, 0.3, 0.42, e),
    q("call", 103, 0.26, 0.3, e),
    q("call", 104, 0.2, 0.22, e),
    q("call", 105, 0.15, 0.1, e),
  ];
  const picked = { quote: chain[1]!, delta: 0.35 };
  const order = liquidOrder(chain, 100, "call", e, picked, {
    otmScanMax: 0.2,
    maxStrikes: 16,
    minPrice: 0.2,
  });
  // 0.30, 0.26 out (0.20 is under the band); then 0.48 toward the money.
  assert.deepEqual(
    order.map((c) => c.quote.strike),
    [102, 103, 100],
  );
});
