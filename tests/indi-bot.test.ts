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
  coreClose,
  newYorkToUtc,
  previousSessions,
} from "../packages/market-data/src/calendar.js";
import {
  premarketBlocks,
  premarketRatio,
  reactionReport,
  reportDates,
  type EarningsReport,
  type NewsCalendar,
} from "../packages/trading/src/bot/news.js";
import {
  nextAction,
  nightCapSell,
  type BotPositionState,
  type ExitMarket,
} from "../packages/trading/src/bot/exits.js";
import { pickContract } from "../packages/trading/src/bot/picker.js";
import {
  cSignal,
  defaultSignalParams,
  priorFrom,
  type MinuteBar,
  type PriorDay,
} from "../packages/trading/src/bot/signal.js";
import { formatEntry, formatExit } from "../packages/trading/src/message.js";
import {
  contractWords,
  contractsInWords,
  type OptionQuote,
} from "../packages/trading/src/options.js";
import {
  IndiBot,
  toSessionBars,
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

test("signal (V2): the threshold is t 1.8; a slow climb signals earlier than it would at t 2", () => {
  assert.equal(defaultSignalParams.strengthT, 1.8);
  assert.equal(defaultSignalParams.rvolDay, 1.5);
  const prior = priorFrom(priorDays());
  const spy = session(500, wiggle, () => 50000);
  // A slow, noisy climb: its t-stat passes 1.8 before it passes 2.
  const climb = (m: number) =>
    wiggle(m) * prior.beta! + 0.0001 + (m % 3 === 0 ? 0.0005 : -0.00025);
  const day = session(100, climb, () => 2000);
  const at18 = cSignal(day, spy, prior);
  const at20 = cSignal(day, spy, prior, 374, {
    ...defaultSignalParams,
    strengthT: 2,
  });
  assert.ok(at18 && at20);
  assert.equal(at18.right, "C");
  assert.ok(at18.t >= 1.8 && at18.t < 2);
  assert.ok(at18.minute < at20.minute);
  // Normal volume still gives nothing at 1.8.
  assert.equal(
    cSignal(
      session(100, climb, () => 1000),
      spy,
      prior,
    ),
    null,
  );
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

// The news filter's sources for the harness (both off unless given).
interface NewsFakes {
  earnings?: (date: string) => Promise<EarningsReport[]>;
  premarket?: BotMarket["premarket"];
}

function harness(mode: "dry" | "live", news: NewsFakes = {}) {
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
    ...(news.premarket ? { premarket: news.premarket } : {}),
  };
  let mid = 0.6;
  let equity = 100000;
  let equityFails = false;
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
      if (equityFails) throw new Error("account read failed (synthetic)");
      return equity;
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
    ...(news.earnings ? { earnings: news.earnings } : {}),
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
    setEquity: (v: number) => (equity = v),
    failEquity: (on: boolean) => (equityFails = on),
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
  // The feed names the contract in words, not as an OCC symbol.
  assert.match(texts, /would buy \(dry run\) \(\d+ Call 110 · 2DTE at 0\.60\)/);
  assert.doesNotMatch(texts, /NVDA261023C00110000/);
});

// ---- contracts in words ----

test("favorites: the site resends the list when the bot has none, another name or other stocks", async () => {
  const { favoritesStale } = await import("../packages/trading/src/bot-api.js");
  const list = { name: "Favorites", tickers: ["NVDA", "AMD"] };
  assert.equal(favoritesStale(null, list), true);
  assert.equal(
    favoritesStale({ name: "Favorites", tickers: ["AMD", "NVDA"] }, list),
    false,
  );
  assert.equal(
    favoritesStale({ name: "Tech", tickers: ["NVDA", "AMD"] }, list),
    true,
  );
  assert.equal(
    favoritesStale({ name: "Favorites", tickers: ["NVDA"] }, list),
    true,
  );
});

test("contracts in words: side, strike and calendar days to expiry; 0DTE on expiry day", () => {
  assert.equal(
    contractWords("MU250404P00075000", "2025-04-02"),
    "Put 75 · 2DTE",
  );
  assert.equal(
    contractWords("MU250404P00075000", "2025-04-04"),
    "Put 75 · 0DTE",
  );
  assert.equal(
    contractWords("NVDA261023C00112500", "2026-10-21"),
    "Call 112.5 · 2DTE",
  );
  assert.equal(contractWords("not a contract", "2026-10-21"), "not a contract");
  assert.equal(
    contractsInWords("Bought 3 MU250404P00075000 at 1.20", "2025-04-03"),
    "Bought 3 Put 75 · 1DTE at 1.20",
  );
});

test("bars: provider start times are seconds (RawBar), read as New York session minutes", () => {
  const start = newYorkToUtc(DAY, 570 + 5) / 1000;
  const bars = toSessionBars([
    { start, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    { start: start - 3600, open: 1, high: 1, low: 1, close: 1, volume: 1 }, // pre-market: dropped
  ]);
  assert.deepEqual(bars.get(DAY), [
    { m: 5, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
  ]);
});

// ---- the news filter (SYNTHETIC reports, gaps and volumes) ----

const sessions: NewsCalendar = {
  isSession: (d) => coreClose(d) !== null,
  nextSession: (d) => {
    let x = d;
    do
      x = new Date(Date.parse(`${x}T12:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
    while (coreClose(x) === null);
    return x;
  },
};
const report = (date: string, time: string): EarningsReport => ({
  symbol: "NVDA",
  date,
  time,
});
const noGap = () => 0;

test("news: earnings reaction day before the open, after the close, and on a non-session date", () => {
  // Wednesday 2026-10-21, Thursday 22, Saturday 24, Monday 26.
  const pre = [report("2026-10-21", "time-pre-market")];
  assert.ok(reactionReport(pre, "2026-10-21", sessions, noGap));
  assert.equal(reactionReport(pre, "2026-10-22", sessions, noGap), null);
  const after = [report("2026-10-21", "time-after-hours")];
  assert.equal(reactionReport(after, "2026-10-21", sessions, noGap), null);
  assert.ok(reactionReport(after, "2026-10-22", sessions, noGap));
  // A Saturday listing, whatever its time, reacts on Monday.
  for (const time of ["time-pre-market", "time-not-supplied"]) {
    const weekend = [report("2026-10-24", time)];
    assert.ok(reactionReport(weekend, "2026-10-26", sessions, noGap));
  }
  assert.deepEqual(reportDates("2026-10-26", "2026-10-23"), [
    "2026-10-23",
    "2026-10-24",
    "2026-10-25",
    "2026-10-26",
  ]);
});

test("news: no time given, the listed day when it gaps 2%+, else the next session when it gaps more", () => {
  const rows = [report("2026-10-21", "time-not-supplied")];
  const gaps = (g: Record<string, number>) => (d: string) => g[d] ?? null;
  // The listed day: an open 2.5% away is the reaction; 1.5% is not.
  assert.ok(
    reactionReport(rows, "2026-10-21", sessions, gaps({ "2026-10-21": 0.025 })),
  );
  assert.equal(
    reactionReport(rows, "2026-10-21", sessions, gaps({ "2026-10-21": 0.015 })),
    null,
  );
  // The next session: a bigger gap than the listed day's is the reaction; a smaller one is not.
  assert.ok(
    reactionReport(
      rows,
      "2026-10-22",
      sessions,
      gaps({ "2026-10-21": 0.01, "2026-10-22": 0.03 }),
    ),
  );
  assert.equal(
    reactionReport(
      rows,
      "2026-10-22",
      sessions,
      gaps({ "2026-10-21": 0.03, "2026-10-22": 0.01 }),
    ),
    null,
  );
  // Other stocks' reports and other days do not count.
  assert.equal(reactionReport(rows, "2026-10-23", sessions, noGap), null);
});

test("news: pre-market volume 4x the 20-session median blocks, under 4x or under 10 sessions passes", () => {
  const prior = Array.from({ length: 20 }, (_, i) => (i % 2 ? 900 : 1100));
  assert.equal(premarketRatio(4000, prior), 4);
  assert.ok(premarketBlocks(premarketRatio(4000, prior)));
  assert.ok(!premarketBlocks(premarketRatio(3900, prior)));
  // Days without data are left out; 9 sessions with data are too few.
  const thin = [...Array(11).fill(undefined), ...Array(9).fill(1000)];
  assert.equal(premarketRatio(9000, thin), null);
  assert.ok(!premarketBlocks(premarketRatio(9000, thin)));
  assert.equal(premarketRatio(5000, [...thin.slice(1), 1000]), 5);
  assert.equal(premarketRatio(undefined, prior), null);
});

// Pre-market volume for the harness: 1,000 on each prior session, `today` on DAY.
const premarketOf = (today: number) => async (symbols: string[]) =>
  new Map(
    symbols.map((s) => [
      s,
      new Map([
        ...previousSessions(DAY, 20).map((d) => [d, 1000] as [string, number]),
        [DAY, today] as [string, number],
      ]),
    ]),
  );

test("runner (live): an earnings reaction day is skipped, no buy; the feed says why", async () => {
  const asked: string[] = [];
  const h = harness("live", {
    earnings: async (date) => {
      asked.push(date);
      return date === DAY ? [report(DAY, "time-pre-market")] : [];
    },
  });
  await h.run(DAY, 565, 600);
  assert.deepEqual(asked, ["2026-10-20", DAY]);
  assert.equal(h.calls.length, 0);
  const [s] = h.store.signals(DAY);
  assert.equal(s!.outcome, "earnings");
  assert.match(s!.detail, /report listed 2026-10-21, before the open/);
  const status = h.bot.status();
  assert.equal(status.news.earnings, "ok");
  assert.equal(status.scan[0]!.blocked, "earnings");
  const texts = status.activity.map((e) => e.text).join("\n");
  assert.match(
    texts,
    /Earnings calendar 2026-10-20 to 2026-10-21: reports for NVDA/,
  );
  assert.match(texts, /NVDA call: skipped, earnings reaction day/);
});

test("runner (dry): pre-market volume 5x normal is skipped, no 'would buy'", async () => {
  const h = harness("dry", { premarket: premarketOf(5000) });
  await h.run(DAY, 565, 600);
  assert.equal(h.calls.length, 0);
  assert.ok(!h.notes.some((n) => n.includes("would buy")));
  const [s] = h.store.signals(DAY);
  assert.equal(s!.outcome, "premarket");
  assert.equal(s!.detail, "pre-market volume 5.0× normal");
  assert.equal(h.store.openPositions().length, 0);
  const texts = h.bot
    .status()
    .activity.map((e) => e.text)
    .join("\n");
  assert.match(texts, /4× normal or more, no entry today: NVDA 5\.0×/);
});

test("runner: under 4x pre-market and no report trades as before", async () => {
  const h = harness("live", {
    premarket: premarketOf(3500),
    earnings: async () => [],
  });
  await h.run(DAY, 565, 600);
  assert.equal(h.calls.filter((c) => c.kind === "buy").length, 1);
  assert.equal(h.bot.status().scan[0]!.blocked, null);
});

test("runner: a failed calendar or pre-market read fails open and says so", async () => {
  const h = harness("live", {
    earnings: async () => {
      throw new Error("Nasdaq earnings calendar failed (503)");
    },
    premarket: async () => {
      throw new Error("Alpaca REST request failed (500)");
    },
  });
  await h.run(DAY, 565, 600);
  assert.equal(h.calls.filter((c) => c.kind === "buy").length, 1);
  const status = h.bot.status();
  assert.deepEqual(status.news, { earnings: "failed", premarket: "failed" });
  const errors = status.activity.filter((e) => e.kind === "error");
  assert.ok(
    errors.some((e) => /without the earnings filter/.test(e.text)),
    "earnings failure in the feed",
  );
  assert.ok(
    errors.some((e) => /without the pre-market filter/.test(e.text)),
    "pre-market failure in the feed",
  );
});

test("runner: the news filter blocks entries only; a held position still exits on its reaction day", async () => {
  // Reported after the close on DAY: NEXT is NVDA's reaction day.
  const h = harness("live", {
    earnings: async (date) =>
      date === DAY ? [report(DAY, "time-after-hours")] : [],
  });
  await h.run(DAY, 565, 600);
  assert.equal(h.store.openPositions()[0]!.qty, 33);
  h.setMid(1.5); // up 150% at 15:50: held overnight
  await h.run(DAY, 601, 965);
  await h.run(NEXT, 565, 590);
  const sells = h.calls.filter((c) => c.kind === "sell");
  assert.equal(sells.length, 1);
  assert.equal(sells[0]!.body.qty, "33");
  assert.equal(h.store.openPositions().length, 0);
  assert.equal(h.bot.status().news.earnings, "ok");
});

// ---- the owner's settings (docs/tasks/backend-bot-settings.md) ----

test("settings: size, safety stop and stop words reach the buy and the feed", async () => {
  const h = harness("live");
  const saved = h.bot.setSettings({
    ...h.bot.settings(),
    sizePct: 1,
    safetyStopPct: 60,
  });
  assert.equal(saved.sizePct, 1);
  await h.run(DAY, 565, 600);
  const buy = h.calls.find((c) => c.kind === "buy");
  assert.equal(buy?.body.sizePct, 1);
  assert.equal(buy?.body.stopPct, 60);
  const texts = h.bot
    .status()
    .activity.map((e) => e.text)
    .join("\n");
  assert.match(texts, /Settings changed: sizePct 2 → 1; safetyStopPct 50 → 60/);
  assert.equal(h.bot.status().settings.sizePct, 1);
});

test("settings: a stock turned off is not watched; a stricter signal does not fire", async () => {
  const off = harness("live");
  off.bot.setSettings({ ...off.bot.settings(), off: ["NVDA"] });
  await off.run(DAY, 565, 600);
  assert.equal(off.calls.length, 0);
  assert.deepEqual(off.bot.status().watching, []);
  const strict = harness("live");
  strict.bot.setSettings({ ...strict.bot.settings(), minT: 4, minRvol: 3 });
  await strict.run(DAY, 565, 600);
  assert.equal(strict.store.signals(DAY).length, 0);
});

test("settings: the most open positions and the daily loss limit hold new buys", async () => {
  const full = harness("live");
  full.bot.setSettings({ ...full.bot.settings(), maxOpen: 1 });
  full.store.savePosition({
    id: "x",
    day: DAY,
    symbol: "AMD",
    contract: "AMD261023C00200000",
    right: "C",
    qty: 2,
    bought: 2,
    cost: 1,
    entryMinute: 0,
    entryStock: 1,
    nights: 0,
    checksDone: [],
    morningDone: false,
    decidedOn: null,
    status: "open",
    jobId: null,
    dry: false,
    sales: [],
    openedAt: 0,
    closedAt: null,
  });
  full.held.set("AMD261023C00200000", 2);
  await full.run(DAY, 565, 600);
  assert.equal(full.calls.filter((c) => c.kind === "buy").length, 0);
  assert.equal(full.store.signals(DAY)[0]!.outcome, "max_open");

  const loss = harness("live");
  await loss.run(DAY, 565, 575); // warm-up reads the account at 100,000
  loss.setEquity(94000); // down 6% today, past the 5% limit
  await loss.run(DAY, 576, 600);
  assert.equal(loss.calls.filter((c) => c.kind === "buy").length, 0);
  const [s] = loss.store.signals(DAY);
  assert.equal(s!.outcome, "day_loss");
  assert.match(s!.detail, /down 6\.0% today/);
});

test("settings: the drawdown pause switches the bot off and says so", async () => {
  const h = harness("dry");
  h.bot.setSettings({ ...h.bot.settings(), drawdownPausePct: 5 });
  await h.run(DAY, 565, 600); // would buy 33 at 0.60
  h.setMid(0.3);
  h.setEquity(10000);
  await h.run(DAY, 601, 960); // sold at 15:50 at 0.30: −$990, 9.9% of 10,000
  const status = h.bot.status();
  assert.equal(status.enabled, false);
  assert.ok(h.notes.some((n) => n.includes("paused")));
  assert.match(
    status.activity.map((e) => e.text).join("\n"),
    /Paused: the bot's trades are down \$990/,
  );
  // Switched back on, the pause counts from then.
  h.bot.setEnabled(true);
  await h.run(DAY, 961, 965);
  assert.equal(h.bot.status().enabled, true);
});

// ---- the overnight cap (V2) ----

test("night cap: sells the part above the cap, never more than held; 0 is no cap", () => {
  // 33 at $3.00 = $9,900 against an $8,000 cap: keep 26 ($7,800), sell 7.
  assert.equal(nightCapSell(33, 3, 100000, 8), 7);
  assert.ok((33 - nightCapSell(33, 3, 100000, 8)) * 3 * 100 <= 8000);
  assert.equal(nightCapSell(26, 3, 100000, 8), 0);
  assert.equal(nightCapSell(13, 3, 100000, 8), 0);
  // One contract worth more than the whole cap: all of it, and no more.
  assert.equal(nightCapSell(2, 90, 100000, 8), 2);
  assert.equal(nightCapSell(33, 3, 100000, 5), 33 - 16);
  // Off, or nothing held: nothing.
  assert.equal(nightCapSell(33, 3, 100000, 0), 0);
  assert.equal(nightCapSell(0, 3, 100000, 8), 0);
  // No usable account value or mid: nothing is known to be under the cap.
  assert.equal(nightCapSell(10, 3, Number.NaN, 8), 10);
  assert.equal(nightCapSell(10, 0, 100000, 8), 10);
});

test("runner (live): at 15:50 the night cap sells the excess first, then holds at most 8% overnight", async () => {
  const h = harness("live");
  h.bot.setSettings({ ...h.bot.settings(), nightCapPct: 8 }); // the cases below are worked at 8%
  await h.run(DAY, 565, 600);
  h.setMid(3); // up 400%: 33 × $3.00 × 100 = $9,900 > 8% of $100,000
  await h.run(DAY, 601, 965);
  const sells = h.calls.filter((c) => c.kind === "sell");
  assert.equal(sells.length, 1);
  assert.equal(sells[0]!.body.qty, "7");
  assert.equal(sells[0]!.body.tag, "🤖 Bot");
  assert.match(String(sells[0]!.body.note), /Overnight cap.*8%/);
  const [p] = h.store.openPositions();
  assert.equal(p!.qty, 26);
  assert.equal(p!.nights, 1);
  assert.ok(26 * 3 * 100 <= 8000);
  assert.ok(
    h.notes.some(
      (n) => n.includes("held overnight") && n.includes("26 contracts"),
    ),
  );
  // The kept part follows the morning rule: no gap our way, all 26 out.
  await h.run(NEXT, 565, 590);
  const after = h.calls.filter((c) => c.kind === "sell");
  assert.equal(after.length, 2);
  assert.equal(after[1]!.body.qty, "26");
  assert.equal(h.store.openPositions().length, 0);
});

test("runner (live): the night cap counts what the account holds, never more; under the cap nothing is sold", async () => {
  const h = harness("live");
  h.bot.setSettings({ ...h.bot.settings(), nightCapPct: 8 }); // the cases below are worked at 8%
  await h.run(DAY, 565, 600);
  h.held.set("NVDA261023C00110000", 30); // 3 sold by hand: the bot counts 30
  h.setMid(3); // 30 × $300 = $9,000: keep 26, sell 4
  await h.run(DAY, 601, 965);
  const sells = h.calls.filter((c) => c.kind === "sell");
  assert.equal(sells.length, 1);
  assert.equal(sells[0]!.body.qty, "4");
  assert.equal(h.store.openPositions()[0]!.qty, 26);
  const g = harness("live");
  g.bot.setSettings({ ...g.bot.settings(), nightCapPct: 8 }); // the cases below are worked at 8%
  await g.run(DAY, 565, 600);
  g.held.set("NVDA261023C00110000", 13);
  g.setMid(3); // 13 × $300 = $3,900
  await g.run(DAY, 601, 965);
  assert.equal(g.calls.filter((c) => c.kind === "sell").length, 0);
  assert.equal(g.store.openPositions()[0]!.qty, 13);
});

test("runner (live): nightCapPct 0 is no cap; the whole winner is held", async () => {
  const h = harness("live");
  h.bot.setSettings({ ...h.bot.settings(), nightCapPct: 0 });
  await h.run(DAY, 565, 600);
  h.setMid(3);
  await h.run(DAY, 601, 965);
  assert.equal(h.calls.filter((c) => c.kind === "sell").length, 0);
  assert.equal(h.store.openPositions()[0]!.qty, 33);
  assert.equal(h.store.openPositions()[0]!.nights, 1);
});

test("runner (live): a failed account read at 15:50 caps with the last value read today", async () => {
  const h = harness("live");
  h.bot.setSettings({ ...h.bot.settings(), nightCapPct: 8 }); // the cases below are worked at 8%
  await h.run(DAY, 565, 600); // warm-up read $100,000
  h.setMid(3);
  h.failEquity(true);
  await h.run(DAY, 601, 965);
  const sells = h.calls.filter((c) => c.kind === "sell");
  assert.equal(sells.length, 1);
  assert.equal(sells[0]!.body.qty, "7");
  assert.equal(h.store.openPositions()[0]!.qty, 26);
  const feed = h.store.events(200).map((e) => e.text);
  assert.ok(feed.some((t) => /could not be read at the day exit/.test(t)));
  assert.ok(
    feed.some((t) => /last account value read today \(\$100000\)/.test(t)),
  );
});

test("runner (live): no account value all day sells the carry at 15:50 and says why", async () => {
  const h = harness("live");
  h.failEquity(true); // from the warm-up on
  await h.run(DAY, 565, 600);
  assert.ok(h.calls.some((c) => c.kind === "buy"));
  h.setMid(3);
  await h.run(DAY, 601, 965);
  const sells = h.calls.filter((c) => c.kind === "sell");
  assert.equal(sells.length, 1);
  assert.equal(sells[0]!.body.qty, "33");
  assert.match(String(sells[0]!.body.note), /no account value today/);
  assert.equal(h.store.openPositions().length, 0);
  assert.ok(
    h.store
      .events(200)
      .some((e) => /nothing is held overnight: selling all 33/.test(e.text)),
  );
  assert.ok(!h.notes.some((n) => n.includes("held overnight")));
});

test("runner (dry): the night cap is a 'would sell' with no order", async () => {
  const h = harness("dry");
  h.bot.setSettings({ ...h.bot.settings(), nightCapPct: 8 }); // the cases below are worked at 8%
  await h.run(DAY, 565, 600);
  h.setMid(3);
  await h.run(DAY, 601, 965);
  assert.equal(h.calls.length, 0);
  assert.ok(
    h.notes.some(
      (n) => n.includes("would sell") && n.includes("Overnight cap"),
    ),
  );
  const [p] = h.store.openPositions();
  assert.equal(p!.qty, 26);
  assert.equal(p!.nights, 1);
  assert.ok(
    h.notes.some(
      (n) => n.includes("held overnight") && n.includes("26 contracts"),
    ),
  );
});
