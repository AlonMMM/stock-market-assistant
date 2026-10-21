// SYNTHETIC market data, chains and fills: the Indi bot's signal, exits,
// contract choice, posts and runner (docs/tasks/backend-indi-bot.md). The
// signal and exits are also checked against the Python backtest on real bars
// by scripts/bot-parity.ts and scripts/bot-exit-parity.ts (local data only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newYorkToUtc,
  previousSessions,
} from "../packages/market-data/src/calendar.js";
import {
  nextAction,
  type BotPositionState,
  type ExitMarket,
} from "../packages/trading/src/bot/exits.js";
import { pickContract } from "../packages/trading/src/bot/picker.js";
import {
  cSignal,
  priorFrom,
  type MinuteBar,
  type PriorDay,
} from "../packages/trading/src/bot/signal.js";
import { formatEntry, formatExit } from "../packages/trading/src/message.js";
import type { OptionQuote } from "../packages/trading/src/options.js";
import {
  IndiBot,
  type BotMarket,
  type BotTrading,
} from "../apps/trader/src/bot.js";
import { BotStore } from "../apps/trader/src/bot-store.js";

// ---- synthetic bars ----

/** A session of minute bars: price path from `step(m)`, volume `vol(m)`. */
function session(
  start: number,
  step: (m: number) => number,
  vol: (m: number) => number,
  upTo = 389,
): MinuteBar[] {
  const out: MinuteBar[] = [];
  let p = start;
  for (let m = 0; m <= upTo; m++) {
    const o = p;
    p = p * (1 + step(m));
    out.push({ m, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: vol(m) });
  }
  return out;
}
// A quiet market: SPY wiggles, stocks wiggle with it.
const wiggle = (m: number) => (m % 2 ? 0.0004 : -0.0004);
const priorDays = (): PriorDay[] =>
  Array.from({ length: 20 }, () => ({
    stock: session(
      100,
      (m) => wiggle(m) * 1.5 + (m % 7 === 0 ? 0.0003 : -0.00005),
      () => 1000,
    ),
    spy: session(500, wiggle, () => 50000),
  }));

test("signal: a steady climb against a flat SPY on 2x volume is a call signal from 09:40", () => {
  const prior = priorFrom(priorDays());
  assert.ok(prior.beta !== null);
  const spy = session(500, wiggle, () => 50000);
  const day = session(
    100,
    (m) => wiggle(m) * prior.beta! + 0.0008,
    () => 2000,
  );
  const s = cSignal(day, spy, prior);
  assert.ok(s);
  assert.equal(s.right, "C");
  assert.ok(s.minute >= 10);
  assert.ok(s.rvol >= 1.5);
  // Asked again with fewer bars, it answers the same first minute.
  assert.deepEqual(
    cSignal(day.slice(0, s.minute + 1), spy, prior, s.minute)?.minute,
    s.minute,
  );
});

test("signal: a steady fall is a put; normal volume or too few prior days is nothing", () => {
  const days = priorDays();
  const prior = priorFrom(days);
  const spy = session(500, wiggle, () => 50000);
  const down = session(
    100,
    (m) => wiggle(m) * prior.beta! - 0.0008,
    () => 2000,
  );
  assert.equal(cSignal(down, spy, prior)?.right, "P");
  const quiet = session(
    100,
    (m) => wiggle(m) * prior.beta! + 0.0008,
    () => 1000,
  );
  assert.equal(cSignal(quiet, spy, prior), null);
  assert.equal(cSignal(down, spy, priorFrom(days.slice(0, 5))), null);
});

// ---- exits ----

const pos = (over: Partial<BotPositionState> = {}): BotPositionState => ({
  right: "C",
  qty: 10,
  cost: 1,
  entryMinute: 60,
  entryStock: 100,
  nights: 0,
  checksDone: [],
  morningDone: false,
  ...over,
});
const mk = (over: Partial<ExitMarket> = {}): ExitMarket => ({
  minute: 61,
  stock: 100.5,
  option: 1.1,
  isExpiryDay: false,
  sessionBeforeExpiry: true,
  open: null,
  prevClose: null,
  ...over,
});

test("exits: the 10- and 20-minute checks sell half, then the rest, only with the stock against", () => {
  assert.deepEqual(nextAction(pos(), mk({ minute: 70, stock: 99.9 })), {
    sell: 5,
    reason: "check-10",
    update: { checksDone: [0] },
  });
  assert.deepEqual(nextAction(pos(), mk({ minute: 70, stock: 100.1 })), {
    sell: 0,
    reason: null,
    update: { checksDone: [0] },
  });
  assert.deepEqual(
    nextAction(pos({ qty: 5, checksDone: [0] }), mk({ minute: 80, stock: 99 }))
      .sell,
    5,
  );
  assert.equal(
    nextAction(pos({ qty: 3 }), mk({ minute: 70, stock: 99 })).sell,
    2,
  ); // half rounds up
  // A put is against when the stock rises.
  assert.equal(
    nextAction(pos({ right: "P" }), mk({ minute: 70, stock: 100.1 })).reason,
    "check-10",
  );
});

test("exits: -30% sells all only with the stock against on the entry day", () => {
  assert.equal(
    nextAction(pos({ checksDone: [0, 1] }), mk({ option: 0.69, stock: 99 }))
      .reason,
    "stop-30",
  );
  assert.equal(
    nextAction(pos({ checksDone: [0, 1] }), mk({ option: 0.69, stock: 101 }))
      .sell,
    0,
  );
  // A carried day: -30% sells all whatever the stock does.
  assert.equal(
    nextAction(
      pos({ nights: 1, morningDone: true }),
      mk({ minute: 100, option: 0.69, stock: 101 }),
    ).reason,
    "stop-30",
  );
});

test("exits: 15:50 holds a +100% winner overnight, sells the rest; once a day", () => {
  assert.deepEqual(
    nextAction(pos({ checksDone: [0, 1] }), mk({ minute: 380, option: 2.1 })),
    { sell: 0, reason: "carry", update: { nights: 1 } },
  );
  assert.equal(
    nextAction(pos({ checksDone: [0, 1] }), mk({ minute: 380, option: 1.9 }))
      .reason,
    "close-1550",
  );
  assert.equal(
    nextAction(
      pos({ checksDone: [0, 1] }),
      mk({ minute: 380, option: 3, sessionBeforeExpiry: false }),
    ).reason,
    "close-1550",
  );
  assert.equal(
    nextAction(
      pos({ nights: 2, morningDone: true }),
      mk({ minute: 380, option: 3 }),
    ).reason,
    "close-1550",
  );
  // After the decision, nothing more that evening (not the morning rule either).
  assert.equal(
    nextAction(
      pos({ nights: 1 }),
      mk({ minute: 385, option: 2.1 }),
      undefined,
      true,
    ).sell,
    0,
  );
});

test("exits: the first carried morning keeps half on a gap our way, else sells all; nothing before 09:40", () => {
  const night = pos({ nights: 1 });
  assert.equal(
    nextAction(night, mk({ minute: 5, open: 101, prevClose: 100 })).sell,
    0,
  );
  assert.deepEqual(
    nextAction(night, mk({ minute: 10, open: 101, prevClose: 100 })),
    { sell: 5, reason: "morning-gap-keep", update: { morningDone: true } },
  );
  assert.equal(
    nextAction(night, mk({ minute: 10, open: 100.2, prevClose: 100 })).reason,
    "morning-gap-against",
  );
  assert.equal(
    nextAction(night, mk({ minute: 10, open: 99, prevClose: 100 })).sell,
    10,
  );
  assert.equal(
    nextAction(
      pos({ nights: 1, morningDone: true }),
      mk({ minute: 360, isExpiryDay: true }),
    ).reason,
    "expiry-day",
  );
});

// ---- contract choice ----

const q = (
  strike: number,
  delta: number,
  bid: number,
  expiry = "2026-10-23",
  right: "call" | "put" = "call",
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

test("picker: nearest expiry 1-7 days out, OTM, the delta closest to 0.15; too cheap is no trade", () => {
  const chain = [
    q(105, 0.3, 1.5),
    q(110, 0.16, 0.6),
    q(115, 0.09, 0.25),
    q(95, 0.7, 6),
    q(110, 0.2, 1.2, "2026-10-30"),
    q(110, 0.18, 0.5, "2026-10-21"),
  ];
  const p = pickContract(chain, 102, "call", "2026-10-21");
  assert.ok(p.ok);
  assert.equal(p.quote.strike, 110);
  assert.equal(p.quote.expiry, "2026-10-23");
  assert.deepEqual(
    pickContract([q(115, 0.15, 0.1)], 102, "call", "2026-10-21"),
    { ok: false, reason: "too_cheap" },
  );
  assert.deepEqual(
    pickContract([q(110, 0.15, 1, "2026-11-20")], 102, "call", "2026-10-21"),
    { ok: false, reason: "no_expiry" },
  );
  const puts = [
    q(95, 0.14, 0.5, "2026-10-23", "put"),
    q(90, 0.05, 0.21, "2026-10-23", "put"),
  ];
  assert.equal(pickContract(puts, 102, "put", "2026-10-21").ok && 95, 95);
});

// ---- posts ----

test("posts: a tag and a reason appear on the bot's entry and exit", () => {
  const entry = formatEntry(
    {
      symbol: "NVDA261023C00110000",
      paper: true,
      tag: "🤖 Bot",
      note: "Signal call at 10:15",
    },
    {
      order: {
        id: "1",
        symbol: "NVDA261023C00110000",
        status: "filled",
        qty: 20,
        filledQty: 20,
        filledAvgPrice: 0.6,
        limitPrice: 0.6,
      },
      prices: [0.6],
    } as never,
  );
  assert.match(entry, /🧪 PAPER\n🤖 Bot\n/);
  assert.match(entry, /Signal call at 10:15/);
  const exit = formatExit(
    {
      symbol: "NVDA261023C00110000",
      paper: true,
      tag: "🤖 Bot",
      note: "10-min check",
    },
    {
      held: 20,
      entry: 0.6,
      asked: 10,
      sold: 10,
      price: 0.5,
      remaining: 10,
      attempts: 1,
      timedOut: false,
      stop: null,
    },
  );
  assert.match(exit, /🤖 Bot/);
  assert.match(exit, /10-min check/);
});

// ---- the runner, on a synthetic day ----

const DAY = "2026-10-21"; // a Wednesday session
const NEXT = "2026-10-22";
const at = (date: string, wall: number, sec = 20) =>
  newYorkToUtc(date, wall) + sec * 1000;

function harness(mode: "dry" | "live") {
  const store = new BotStore(
    join(mkdtempSync(join(tmpdir(), "bot-")), "t.sqlite"),
  );
  const prior = priorDays();
  const beta = priorFrom(prior).beta!;
  const days = previousSessions(DAY, 20);
  const today: Record<string, Map<string, MinuteBar[]>> = {
    NVDA: new Map([
      [
        DAY,
        session(
          100,
          (m) => wiggle(m) * beta + 0.0008,
          () => 2000,
        ),
      ],
      [
        NEXT,
        session(
          110,
          () => 0,
          () => 2000,
        ),
      ],
    ]),
    SPY: new Map([
      [DAY, session(500, wiggle, () => 50000)],
      [
        NEXT,
        session(
          500,
          () => 0,
          () => 50000,
        ),
      ],
    ]),
  };
  const market: BotMarket = {
    async sessions(symbols, dates) {
      const of = (s: string, d: string) => {
        const seen = today[s]?.get(d);
        if (seen) return seen;
        const p = prior[Math.max(0, days.indexOf(d))]!;
        return [...(s === "SPY" ? p.spy : p.stock)];
      };
      return new Map(
        symbols.map((s) => [s, new Map(dates.map((d) => [d, of(s, d)]))]),
      );
    },
    async bars(symbols, date, from, to) {
      return new Map(
        symbols.map((s) => [
          s,
          (today[s]?.get(date) ?? []).filter((b) => b.m >= from && b.m <= to),
        ]),
      );
    },
    async optionVolume30() {
      return 500;
    },
  };
  let mid = 0.6;
  const held = new Map<string, number>();
  const jobs = new Map<string, { state: string; result: unknown }>();
  const calls: { kind: string; body: Record<string, unknown> }[] = [];
  const notes: string[] = [];
  const trading: BotTrading = {
    async chain() {
      return [q(110, 0.15, 0.59), q(115, 0.08, 0.3)];
    },
    async quote(c) {
      return { ...q(110, 0.15, mid - 0.01), symbol: c, ask: mid + 0.01 };
    },
    async held(c) {
      const n = held.get(c) ?? 0;
      return n > 0 ? { qty: n, avgEntryPrice: 0.6 } : null;
    },
    async equity() {
      return 100000;
    },
    async buy(body) {
      calls.push({ kind: "buy", body });
      held.set(String(body.contract), 33);
      jobs.set("b1", { state: "done", result: {} });
      return { status: "started", jobId: "b1", qty: 33 };
    },
    async sell(body) {
      calls.push({ kind: "sell", body });
      const id = `s${calls.length}`;
      const n = Number(body.qty);
      held.set(
        String(body.contract),
        (held.get(String(body.contract)) ?? 0) - n,
      );
      jobs.set(id, { state: "done", result: { result: { sold: n } } });
      return { status: "started", jobId: id };
    },
    job(id) {
      return jobs.get(id)!;
    },
  };
  let now = at(DAY, 560);
  const bot = new IndiBot({
    store,
    market,
    trading,
    universe: ["NVDA"],
    mode,
    enabled: true,
    now: () => now,
    notify: async (title, lines) => {
      notes.push([title, ...lines].join(" | "));
    },
  });
  const run = async (date: string, from: number, to: number) => {
    for (let w = from; w <= to; w++) {
      now = at(date, w);
      await bot.tick();
    }
  };
  return {
    bot,
    store,
    run,
    calls,
    notes,
    held,
    setMid: (v: number) => (mid = v),
  };
}

test("runner (live): signal -> buy with the bot tag -> no check sale while winning -> overnight -> morning gap", async () => {
  const h = harness("live");
  await h.run(DAY, 565, 600); // through 10:00
  const buy = h.calls.find((c) => c.kind === "buy");
  assert.ok(buy);
  assert.equal(buy.body.contract, "NVDA261023C00110000");
  assert.equal(buy.body.sizePct, 2);
  assert.equal(buy.body.tag, "🤖 Bot");
  const [p] = h.store.openPositions();
  assert.equal(p!.status, "open");
  assert.equal(p!.qty, 33);
  // The stock keeps rising: the checks pass, nothing is sold. Up 150% at 15:50: held overnight.
  h.setMid(1.5);
  await h.run(DAY, 601, 965);
  assert.equal(h.calls.filter((c) => c.kind === "sell").length, 0);
  assert.ok(h.notes.some((n) => n.includes("held overnight")));
  assert.ok(h.notes.some((n) => n.includes("day summary")));
  // Next day the stock opens flat (no gap our way): all sold at 09:40, exactly what the bot holds.
  await h.run(NEXT, 565, 585);
  const sells = h.calls.filter((c) => c.kind === "sell");
  assert.equal(sells.length, 1);
  assert.equal(sells[0]!.body.qty, "33");
  assert.match(String(sells[0]!.body.note), /no gap our way/);
  await h.run(NEXT, 586, 590);
  assert.equal(h.store.openPositions().length, 0);
});

test("runner: a contract the account already holds is left alone; the bot never sells more than the account has", async () => {
  const h = harness("live");
  h.held.set("NVDA261023C00110000", 5); // the user's own position
  await h.run(DAY, 565, 600);
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.signals(DAY)[0]!.outcome, "held");
});

test("runner (dry): no orders, 'would buy' and 'would sell' posts", async () => {
  const h = harness("dry");
  await h.run(DAY, 565, 600);
  h.setMid(0.3); // -50% while the stock... still rises: no sale on the entry day
  await h.run(DAY, 601, 955);
  assert.equal(h.calls.length, 0);
  assert.ok(h.notes.some((n) => n.includes("would buy")));
  assert.ok(
    h.notes.some(
      (n) => n.includes("would sell") && n.includes("Sold at 15:50"),
    ),
  );
});

test("runner: when contracts leave the account by hand or by stop, the bot sells only what is left", async () => {
  const h = harness("live");
  await h.run(DAY, 565, 600);
  h.held.set("NVDA261023C00110000", 13); // the user sold 20 of the bot's 33
  await h.run(DAY, 601, 605);
  assert.equal(h.store.openPositions()[0]!.qty, 13);
  h.setMid(0.7); // up 17% at 15:50: sold, and only the 13
  await h.run(DAY, 606, 955);
  const sells = h.calls.filter((c) => c.kind === "sell");
  assert.equal(sells.length, 1);
  assert.equal(sells[0]!.body.qty, "13");
});

test("favorites: the named list, else the one called favorite; the bot adds it to its stocks", async () => {
  const { favoritesList } = await import("../packages/trading/src/bot-api.js");
  const lists = [
    { name: "all", tickers: ["X"], builtIn: true as const },
    { name: "Tech", tickers: ["MSFT"] },
    { name: "⭐ Favorites", tickers: ["NVDA", "AMD", "spy"] },
  ];
  assert.equal(favoritesList(lists)?.name, "⭐ Favorites");
  assert.equal(favoritesList(lists, "tech")?.name, "Tech");
  assert.equal(favoritesList([{ name: "Tech", tickers: [] }]), undefined);
  const h = harness("dry");
  assert.deepEqual(
    h.bot.setWatchlist("⭐ Favorites", ["nvda", "AMD", "SPY", "bad ticker!"]),
    ["NVDA", "AMD"],
  );
  await h.run(DAY, 565, 600);
  const s = h.bot.status();
  assert.deepEqual(s.watching, ["NVDA", "AMD"]);
  assert.equal(s.favorites?.name, "⭐ Favorites");
  // The live scan has NVDA's numbers, and the activity feed tells the story.
  assert.ok(s.scan.some((r) => r.symbol === "NVDA" && r.t >= 2));
  const texts = s.activity.map((e) => e.text).join("\n");
  assert.match(texts, /Favorites list "⭐ Favorites" received: 2 stocks/);
  assert.match(
    texts,
    /Ready for 2026-10-21: watching 2 stocks \(1 from Indi's list, 1 more from "⭐ Favorites"\)/,
  );
  assert.match(texts, /NVDA call signal at/);
  assert.match(texts, /NVDA call: would buy \(dry run\)/);
});
