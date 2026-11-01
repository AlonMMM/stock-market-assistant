// SYNTHETIC market data, chains and fills: the Indi bot's signal, exits,
// contract choice, posts and runner (docs/tasks/backend-indi-bot.md). The
// signal and exits are also checked against the Python backtest on real bars
// by scripts/bot-parity.ts and scripts/bot-exit-parity.ts (local data only).
import { test } from "node:test";
import type { BotBroker } from "../packages/trading/src/bot/settings.js";
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
  advanceWatch,
  priorLevels,
  watchFor,
} from "../packages/trading/src/bot/levels.js";
import {
  premarketBlocks,
  premarketRatio,
  reactionReport,
  reportDates,
  type EarningsReport,
  type NewsCalendar,
} from "../packages/trading/src/bot/news.js";
import {
  defaultExitRules,
  nextAction,
  nightCapSell,
  type BotPositionState,
  type ExitMarket,
} from "../packages/trading/src/bot/exits.js";
import {
  defaultPickRules,
  pickContract,
} from "../packages/trading/src/bot/picker.js";
import {
  cSignal,
  cState,
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
  chaseBuyMs,
  IndiBot,
  sellWaitMs,
  toSessionBars,
  type BotMarket,
  type BotTrading,
} from "../apps/trader/src/bot.js";
import { BotStore } from "../apps/trader/src/bot-store.js";
import { applyVersion } from "../packages/trading/src/bot/versions.js";
import {
  defaultSettings,
  parseSettings,
  pickRules,
  sizeAt,
} from "../packages/trading/src/bot/settings.js";
import type { BotPosition } from "../apps/trader/src/bot-store.js";

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

test("signal (2.5): the D2 bonus enters at t 1.2 when the stock held up on SPY's down minutes", () => {
  assert.equal(defaultSignalParams.bonusT, null);
  const prior = priorFrom(priorDays());
  assert.ok(prior.beta !== null && prior.unit !== null);
  const beta = prior.beta;
  // SPY falls every third minute and rises otherwise.
  const spyStep = (m: number) => (m % 3 === 0 ? -0.0008 : 0.0004);
  const spy = session(500, spyStep, () => 50000);
  // On SPY's down minutes the stock falls only part of beta × SPY; otherwise
  // it moves with it, noisily, drifting a little down.
  const stock = (hold: number, drift: number) =>
    session(
      100,
      (m) =>
        m % 3 === 0
          ? beta * spyStep(m) * (1 - hold)
          : beta * spyStep(m) + drift + (m % 2 ? 0.0006 : -0.0006),
      () => 2000,
    );
  const bonus = { ...defaultSignalParams, bonusT: 1.2 };
  const held = stock(0.6, -0.0002);
  const plain = cSignal(held, spy, prior);
  const early = cSignal(held, spy, prior, 374, bonus);
  assert.ok(plain && early);
  assert.equal(plain.bonus, false);
  assert.ok(plain.t >= 1.8);
  assert.equal(early.right, "C");
  assert.equal(early.bonus, true);
  assert.ok(early.t >= 1.2 && early.t < 1.8);
  assert.ok(early.d2! >= 1.5);
  assert.ok(early.minute < plain.minute);
  // Held up less (D2 under 1.5): the bonus does not fire; the entry waits for t 1.8.
  const weak = stock(0.4, -0.0001);
  const late = cSignal(weak, spy, prior, 374, bonus);
  assert.equal(late?.bonus, false);
  assert.equal(late?.minute, cSignal(weak, spy, prior)?.minute);
  // Without the stock's unit (short history) there is no D2: t 1.8 only.
  const noUnit = cSignal(held, spy, { ...prior, unit: null }, 374, bonus);
  assert.equal(noUnit?.minute, plain.minute);
  // The live scan's D2 is the signal's own at the same minute; no unit, no D2.
  const now = cState(held, spy, prior, early.minute);
  assert.equal(now?.d2?.toFixed(9), early.d2!.toFixed(9));
  assert.equal(cState(held, spy, { ...prior, unit: null }, 100)?.d2, null);
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

test("exits: the rest stop (2.4): after the 10-minute half, the rest out at -20% with the stock against, entry day only", () => {
  const r = { ...defaultExitRules, restStopOut: -0.2 };
  const rest = pos({ qty: 5, checksDone: [0, 1], halfSold: true });
  assert.deepEqual(nextAction(rest, mk({ option: 0.79, stock: 99 }), r), {
    sell: 5,
    reason: "rest-stop",
    update: {},
  });
  // The stock with the entry: held.
  assert.equal(nextAction(rest, mk({ option: 0.79, stock: 101 }), r).sell, 0);
  // Not cut at 10 minutes: the -30% stop as before.
  const whole = pos({ checksDone: [0, 1] });
  assert.equal(nextAction(whole, mk({ option: 0.79, stock: 99 }), r).sell, 0);
  assert.equal(
    nextAction(whole, mk({ option: 0.69, stock: 99 }), r).reason,
    "stop-30",
  );
  // Off (null): the rest keeps -30%.
  assert.equal(nextAction(rest, mk({ option: 0.79, stock: 99 })).sell, 0);
  // A carried day keeps -30%.
  assert.equal(
    nextAction(
      pos({ qty: 5, nights: 1, morningDone: true, halfSold: true }),
      mk({ minute: 100, option: 0.79, stock: 99 }),
      r,
    ).sell,
    0,
  );
});

test("exits: the strength-gone sale: the signal's t at 0.5 or under sells all, on the entry day only", () => {
  const r = { ...defaultExitRules, strengthOut: 0.5 };
  assert.equal(
    nextAction(pos(), mk({ strength: 0.4 }), r).reason,
    "strength-gone",
  );
  assert.equal(nextAction(pos(), mk({ strength: 0.6 }), r).sell, 0);
  // A put reads the call-side t negated.
  assert.equal(
    nextAction(pos({ right: "P" }), mk({ strength: -0.4 }), r).reason,
    "strength-gone",
  );
  assert.equal(
    nextAction(pos({ right: "P" }), mk({ strength: -0.6 }), r).sell,
    0,
  );
  // Off, unknown, or a carried day: nothing.
  assert.equal(nextAction(pos(), mk({ strength: 0.4 })).sell, 0);
  assert.equal(nextAction(pos(), mk({ strength: null }), r).sell, 0);
  assert.equal(
    nextAction(
      pos({ nights: 1, morningDone: true }),
      mk({ minute: 100, strength: 0.4 }),
      r,
    ).sell,
    0,
  );
  // It comes before the checks and the stop.
  assert.equal(
    nextAction(pos(), mk({ minute: 70, stock: 99, strength: 0.2 }), r).reason,
    "strength-gone",
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
  const cheap = pickContract([q(115, 0.15, 0.1)], 102, "call", "2026-10-21");
  assert.equal(cheap.ok, false);
  assert.equal(!cheap.ok && cheap.reason, "too_cheap");
  assert.equal(!cheap.ok && cheap.quote?.strike, 115);
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

test("picker: the cheap fallback takes the cheapest strike toward the money at the minimum or more", () => {
  const rules = { ...defaultPickRules, cheapFallback: true };
  // 0.15-delta strike 115 costs 0.11 (mid); 112 costs 0.21, 110 0.41: the fallback takes 112, the cheapest at $0.20+
  const chain = [
    q(115, 0.15, 0.1),
    q(112, 0.2, 0.2),
    q(110, 0.25, 0.4),
    q(118, 0.1, 0.25),
  ];
  const off = pickContract(chain, 102, "call", "2026-10-21");
  assert.equal(!off.ok && off.reason, "too_cheap");
  const on = pickContract(chain, 102, "call", "2026-10-21", rules);
  assert.ok(on.ok);
  assert.equal(on.quote.strike, 112);
  assert.equal(on.fallback, "cheap");
  // never further out of the money than the too-cheap pick (118 has a lower delta)
  const none = pickContract(
    [q(115, 0.15, 0.1), q(118, 0.1, 0.3)],
    102,
    "call",
    "2026-10-21",
    rules,
  );
  assert.equal(!none.ok && none.reason, "too_cheap");
  // a pick that already costs enough is not a fallback
  const plain = pickContract(
    [q(110, 0.16, 0.6)],
    102,
    "call",
    "2026-10-21",
    rules,
  );
  assert.ok(plain.ok);
  assert.equal(plain.fallback, undefined);
  // puts: toward the money is a higher strike
  const puts = [
    q(90, 0.15, 0.1, "2026-10-23", "put"),
    q(93, 0.22, 0.3, "2026-10-23", "put"),
  ];
  const put = pickContract(puts, 102, "put", "2026-10-21", rules);
  assert.ok(put.ok);
  assert.equal(put.quote.strike, 93);
});

// ---- posts ----

test("posts: a tag and a reason appear on the bot's entry and exit", () => {
  const entry = formatEntry(
    {
      symbol: "NVDA261023C00110000",
      paper: true,
      tag: "🤖 Main bot",
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
  assert.match(entry, /🧪 PAPER\n🤖 Main bot\n/);
  assert.match(entry, /Signal call at 10:15/);
  const exit = formatExit(
    {
      symbol: "NVDA261023C00110000",
      paper: true,
      tag: "🤖 Main bot",
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
  assert.match(exit, /🤖 Main bot/);
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

function harness(
  mode: "dry" | "live",
  news: NewsFakes = {},
  nvdaDay?: (beta: number) => MinuteBar[],
  opts: { brokers?: BotBroker[] } = {},
) {
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
        nvdaDay?.(beta) ??
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
  let ibkrBuyFails = false;
  // What each account holds; `held` is Alpaca's, as the older tests use it.
  const heldBy: Record<BotBroker, Map<string, number>> = {
    alpaca: new Map<string, number>(),
    ibkr: new Map<string, number>(),
  };
  const held = heldBy.alpaca;
  const jobs = new Map<string, { state: string; result: unknown }>();
  const calls: {
    kind: string;
    body: Record<string, unknown>;
    options?: { repeatOk?: boolean };
    broker: BotBroker;
  }[] = [];
  const notes: string[] = [];
  // The broker the bot asked for last; each order records it.
  let broker: BotBroker = "alpaca";
  let refuseAbove = Infinity;
  const trading: BotTrading = {
    async chain() {
      return [q(110, 0.15, 0.59), q(115, 0.08, 0.3)];
    },
    async quote(c) {
      return { ...q(110, 0.15, mid - 0.01), symbol: c, ask: mid + 0.01 };
    },
    async held(c) {
      const n = heldBy[broker].get(c) ?? 0;
      return n > 0 ? { qty: n, avgEntryPrice: 0.6 } : null;
    },
    async equity() {
      if (equityFails) throw new Error("account read failed (synthetic)");
      return equity;
    },
    async buy(body, options) {
      if (broker === "ibkr" && ibkrBuyFails)
        throw new Error(
          "market data requires additional subscription (synthetic)",
        );
      calls.push({
        kind: "buy",
        body,
        broker,
        ...(options ? { options } : {}),
      });
      // A risk limit stand-in: the service refuses a size over refuseAbove.
      if (Number(body.sizePct) > refuseAbove)
        return {
          status: "refused",
          refused: ["risk: over the limit (synthetic)"],
        };
      // IBKR fills one contract fewer: the accounts should differ a little.
      const qty = broker === "ibkr" ? 32 : 33;
      // A buy adds to what the account holds (a pyramid add can buy more of a held contract).
      heldBy[broker].set(
        String(body.contract),
        (heldBy[broker].get(String(body.contract)) ?? 0) + qty,
      );
      const id = `b${calls.length}`;
      jobs.set(id, { state: "done", result: {} });
      return { status: "started", jobId: id, qty };
    },
    async sell(body) {
      calls.push({ kind: "sell", body, broker });
      const id = `s${calls.length}`;
      const n = Number(body.qty);
      heldBy[broker].set(
        String(body.contract),
        (heldBy[broker].get(String(body.contract)) ?? 0) - n,
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
    trading: (b) => {
      broker = b;
      return trading;
    },
    brokers: opts.brokers ?? ["alpaca", "ibkr"],
    broker: "alpaca",
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
  const tickAt = async (date: string, wall: number, sec: number) => {
    now = at(date, wall, sec);
    await bot.tick();
  };
  return {
    bot,
    store,
    run,
    tickAt,
    calls,
    notes,
    held,
    setMid: (v: number) => (mid = v),
    setEquity: (v: number) => (equity = v),
    failEquity: (on: boolean) => (equityFails = on),
    refuseOver: (pct: number) => (refuseAbove = pct),
    failIbkrBuy: (on: boolean) => (ibkrBuyFails = on),
  };
}

test("runner (live): signal -> buy with the bot tag -> no check sale while winning -> overnight -> morning gap", async () => {
  const h = harness("live");
  await h.run(DAY, 565, 600); // through 10:00
  const buy = h.calls.find((c) => c.kind === "buy");
  assert.ok(buy);
  assert.equal(buy.body.contract, "NVDA261023C00110000");
  assert.equal(buy.body.sizePct, 3);
  assert.equal(buy.body.tag, "🤖 Main bot");
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

test("broker setting: new entries go to the chosen broker; a position is sold where it was bought", async () => {
  const h = harness("live");
  await h.run(DAY, 565, 600);
  const buy = h.calls.find((c) => c.kind === "buy")!;
  assert.equal(buy.broker, "alpaca");
  assert.equal(h.store.openPositions()[0]!.broker, "alpaca");
  // The owner moves new entries to IBKR while the position is open.
  h.bot.setSettings({ ...h.bot.settings(), broker: "ibkr" });
  assert.equal(h.bot.settings().broker, "ibkr");
  // Next morning, no gap our way: the sale goes to Alpaca, where the contracts are.
  h.setMid(1.5);
  await h.run(DAY, 601, 965);
  await h.run(NEXT, 565, 590);
  const sells = h.calls.filter((c) => c.kind === "sell");
  assert.equal(sells.length, 1);
  assert.equal(sells[0]!.broker, "alpaca");
  assert.equal(h.store.openPositions().length, 0);
  // A broker that is not connected cannot be chosen.
  const g = harness("live", {}, undefined, { brokers: ["alpaca"] });
  assert.throws(
    () => g.bot.setSettings({ ...g.bot.settings(), broker: "ibkr" }),
    /no ibkr account connected/,
  );
  assert.equal(g.bot.canTrade("alpaca"), true);
});

test("broker setting 'both': one signal, one contract, a position at each account; each sold at its own", async () => {
  const h = harness("live");
  h.bot.setSettings({ ...h.bot.settings(), broker: "both" });
  await h.run(DAY, 565, 600);
  const buys = h.calls.filter((c) => c.kind === "buy");
  assert.deepEqual(
    buys.map((b) => [b.broker, b.body.contract]),
    [
      ["alpaca", "NVDA261023C00110000"],
      ["ibkr", "NVDA261023C00110000"],
    ],
  );
  assert.match(String(buys[1]!.body.note), /Interactive Brokers$/);
  // Positions come back in id order, and ids are random: compare by broker.
  const open = h.store.openPositions();
  assert.deepEqual(open.map((p) => [p.broker, p.qty]).sort(), [
    ["alpaca", 33],
    ["ibkr", 32],
  ]);
  // One signal row, with both accounts in its words.
  const signal = h.store.signals(DAY)[0]!;
  assert.equal(signal.outcome, "bought");
  assert.match(signal.detail ?? "", /Alpaca: 33 .*; Interactive Brokers: 32 /);
  // Up 150% at 15:50: both held overnight; next morning no gap: each sold where it was bought.
  h.setMid(1.5);
  await h.run(DAY, 601, 965);
  await h.run(NEXT, 565, 590);
  const sells = h.calls.filter((c) => c.kind === "sell");
  assert.deepEqual(sells.map((c) => [c.broker, c.body.qty]).sort(), [
    ["alpaca", "33"],
    ["ibkr", "32"],
  ]);
  assert.equal(h.store.openPositions().length, 0);
  // "both" needs both accounts connected.
  const g = harness("live", {}, undefined, { brokers: ["alpaca"] });
  assert.throws(
    () => g.bot.setSettings({ ...g.bot.settings(), broker: "both" }),
    /no both account connected/,
  );
});

test("books: the option's bid / ask is kept on the signal, on each account's buy and on every sale", async () => {
  const h = harness("live");
  h.bot.setSettings({ ...h.bot.settings(), broker: "both" });
  await h.run(DAY, 565, 600);
  const signal = h.store.signals(DAY)[0]!;
  assert.equal(signal.book?.contract, "NVDA261023C00110000");
  assert.equal(signal.book?.broker, "alpaca"); // the first account's chain
  assert.ok(signal.book!.bid > 0 && signal.book!.ask > signal.book!.bid);
  const open = h.store.openPositions();
  assert.equal(open.length, 2);
  for (const p of open) {
    assert.ok(p.entryBook, `entry book at ${p.broker}`);
    assert.ok(p.entryBook!.ask > p.entryBook!.bid);
    assert.equal(p.entryBook!.broker, p.broker);
  }
  // Up 150% at 15:50: held; next morning no gap: each sale carries the book it was decided on.
  h.setMid(1.5);
  await h.run(DAY, 601, 965);
  await h.run(NEXT, 565, 590);
  const closed = h.store.recentPositions(DAY).filter((p) => p.day === DAY);
  const sales = closed.flatMap((p) => p.sales);
  assert.deepEqual(
    closed
      .flatMap((p) => p.sales.map((x) => [p.broker, x.book?.broker]))
      .sort(),
    [
      ["alpaca", "alpaca"],
      ["ibkr", "ibkr"],
    ],
  );
  assert.equal(sales.length, 2);
  for (const sale of sales) {
    assert.ok(sale.book, "sale book");
    assert.ok(Math.abs((sale.book!.bid + sale.book!.ask) / 2 - 1.5) < 1e-9);
  }
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
    safetyStopPct: 70,
  });
  assert.equal(saved.sizePct, 1);
  await h.run(DAY, 565, 600);
  const buy = h.calls.find((c) => c.kind === "buy");
  assert.equal(buy?.body.sizePct, 1);
  assert.equal(buy?.body.stopPct, 70);
  const texts = h.bot
    .status()
    .activity.map((e) => e.text)
    .join("\n");
  assert.match(texts, /Settings changed: sizePct 3 → 1; safetyStopPct 60 → 70/);
  assert.equal(h.bot.status().settings.sizePct, 1);
});

test("versions: every entry is stamped with the version in force; changed rules star it; the owner can pick an older one", async () => {
  const h = harness("live");
  assert.equal(h.bot.status().version, "2.10.0");
  await h.run(DAY, 565, 600);
  const buy = h.calls.find((c) => c.kind === "buy");
  assert.match(String(buy?.body.note), /· bot 2\.10\.0$/);
  const [p] = h.store.openPositions();
  assert.equal(p!.version, "2.10.0");
  assert.equal(h.store.signals(DAY)[0]!.version, "2.10.0");
  assert.equal(h.bot.status().positions[0]!.version, "2.10.0");
  const texts = () =>
    h.bot
      .status()
      .activity.map((e) => e.text)
      .join("\n");
  assert.match(texts(), /Ready for 2026-10-21: .*; bot version 2\.10\.0$/m);

  // The stop changed from 2.10's: the next entry is stamped "2.10.0*".
  const edited = harness("live");
  edited.bot.setSettings({ ...edited.bot.settings(), stopPct: 40 });
  assert.equal(edited.bot.status().version, "2.10.0*");
  await edited.run(DAY, 565, 600);
  assert.equal(edited.store.openPositions()[0]!.version, "2.10.0*");
  assert.match(
    String(edited.calls.find((c) => c.kind === "buy")?.body.note),
    /· bot 2\.10\.0\*$/,
  );

  // Version 1.0 picked: its rules (t 2, no night cap, no news filter) run, and the feed says so.
  const old = harness("live");
  const picked = old.bot.setSettings({
    ...old.bot.settings(),
    version: "1.0",
    stopPct: 30,
    checks: true,
    stockStages: false,
    lateHold: false,
    breakEvenLock: false,
    volumeTiers: [],
    sizeSteps: [],
    minT: 2,
    nightCapPct: 0,
    skipEarnings: false,
    skipPremarket: false,
    sellFailedBreak: false,
    sellOnWeakness: false,
    holdFromPct: 100,
    restStopPct: 0,
    d2Entry: false,
    cheapFallback: false,
    lowFloorSymbols: [],
    pyramid: false,
    earlyEntry: false,
  });
  assert.equal(picked.version, "1.0.0");
  assert.equal(old.bot.status().version, "1.0.0");
  assert.match(
    old.bot
      .status()
      .activity.map((e) => e.text)
      .join("\n"),
    /Settings changed: version "2\.10\.0" → "1\.0"; sizeSteps \[\{"from":300000,"pct":2\.5\},\{"from":1000000,"pct":1\.5\},\{"from":4000000,"pct":1\}\] → \[\]; stopPct 60 → 30; restStopPct 20 → 0; checks false → true; sellOnWeakness true → false; holdFromPct 50 → 100; nightCapPct 10 → 0; minT 1\.8 → 2; d2Entry true → false; skipEarnings true → false; skipPremarket true → false; lowFloorSymbols \["IBIT"\] → \[\]; pyramid true → false; earlyEntry true → false; stockStages true → false; lateHold true → false/,
  );
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

test("size steps: a buy is sized for the account as the day started (3%, 2.5% from $300K, 1.5% from $1M, 1% from $4M)", async () => {
  assert.equal(sizeAt(3, defaultSettings.sizeSteps, 100_000), 3);
  assert.equal(sizeAt(3, defaultSettings.sizeSteps, 300_000), 2.5);
  assert.equal(sizeAt(3, defaultSettings.sizeSteps, 999_999), 2.5);
  assert.equal(sizeAt(3, defaultSettings.sizeSteps, 1_000_000), 1.5);
  assert.equal(sizeAt(3, defaultSettings.sizeSteps, 5_000_000), 1);
  assert.equal(sizeAt(3, [], 5_000_000), 3);
  const h = harness("live");
  h.setEquity(1_200_000);
  await h.run(DAY, 565, 600);
  const buy = h.calls.find((c) => c.kind === "buy");
  assert.equal(buy?.body.sizePct, 1.5);
  // steps must rise and stay within the size's limits
  const bad = parseSettings({
    ...defaultSettings,
    sizeSteps: [
      { from: 1_000_000, pct: 2 },
      { from: 500_000, pct: 1 },
    ],
  });
  assert.equal(bad.ok, false);
  const none = parseSettings({ ...defaultSettings, sizeSteps: [] });
  assert.ok(none.ok && none.value.sizeSteps.length === 0);
});

test("settings: the drawdown pause switches the bot off and says so", async () => {
  const h = harness("dry");
  h.bot.setSettings({ ...h.bot.settings(), drawdownPausePct: 5 });
  await h.run(DAY, 565, 600); // would buy 50 at 0.60 (3%)
  h.setMid(0.3);
  h.setEquity(10000);
  await h.run(DAY, 601, 960); // sold at 15:50 at 0.30: −$1,500, 15% of 10,000
  const status = h.bot.status();
  assert.equal(status.enabled, false);
  assert.ok(h.notes.some((n) => n.includes("paused")));
  assert.match(
    status.activity.map((e) => e.text).join("\n"),
    /Paused: the bot's trades are down \$1500/,
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
  assert.equal(sells[0]!.body.tag, "🤖 Main bot");
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

// ---- the failed-break sale (packages/trading/src/bot/levels.ts) ----

const flat = (n: number, c = 100): MinuteBar[] =>
  Array.from({ length: n }, (_, m) => ({ m, o: c, h: c, l: c, c, v: 1 }));

test("levels: the nearest level ahead in the bet's direction, in the stock's unit; none ahead is no watch", () => {
  const prior = priorLevels([
    flat(390, 95),
    flat(390, 96),
    flat(390, 97),
    flat(390, 98),
    session(
      100,
      (m) => (m % 2 ? 0.001 : -0.001),
      () => 1,
    ),
  ])!;
  assert.ok(prior.prevLow < 100 && prior.prevHigh > prior.prevLow);
  assert.equal(prior.fiveLow, 95);
  assert.ok(prior.unit > 0);
  const today = [
    { m: 0, o: 101, h: 104, l: 100.5, c: 101, v: 1 },
    { m: 1, o: 101, h: 101.5, l: 101, c: 101.2, v: 1 },
  ];
  const call = watchFor(prior, today, 2, 102, "C")!;
  assert.equal(call.name, "the day's high");
  assert.equal(call.level, 104);
  assert.equal(call.state, "watching");
  const put = watchFor(prior, today, 2, 102, "P")!;
  assert.equal(put.name, "the day's low");
  assert.equal(watchFor(prior, today, 2, 110, "C"), null);
  assert.equal(watchFor(null, today, 2, 102, "C"), null);
  assert.equal(
    priorLevels([flat(390), flat(390), flat(390), flat(390), []]),
    null,
  );
});

test("levels: a touch then 0.5 units back is a failed break; a close beyond is a break; 30 minutes is the end", () => {
  const w = {
    name: "yesterday's high",
    level: 104,
    unit: 1,
    touch: null,
    state: "watching" as const,
    at: null,
    through: 10,
  };
  const bars = (closes: number[]) =>
    closes.map((c, i) => ({ m: 11 + i, o: c, h: c, l: c, c, v: 1 }));
  const failed = advanceWatch(w, bars([103, 103.8, 103.6, 103.3]), 30, "C");
  assert.deepEqual([failed.state, failed.touch, failed.at], ["failed", 12, 14]);
  const broken = advanceWatch(w, bars([103.8, 104.3]), 30, "C");
  assert.deepEqual([broken.state, broken.at], ["broken", 12]);
  const stalled = bars([103.8, ...Array(31).fill(103.9)]);
  assert.equal(advanceWatch(w, stalled, 60, "C").state, "ended");
  // A put watches a level below; minutes after `to` wait for the next call.
  const put = { ...w, level: 96 };
  const later = advanceWatch(put, bars([97, 96.2, 96.4, 96.8]), 13, "P");
  assert.deepEqual([later.state, later.through], ["watching", 13]);
  assert.equal(
    advanceWatch(later, bars([97, 96.2, 96.4, 96.8]), 30, "P").state,
    "failed",
  );
});

// NVDA climbs from 100 toward the day's high (a 103 wick at 09:31), touches it
// and falls back (synthetic bars).
const failedBreakDay = (beta: number): MinuteBar[] => {
  const out: MinuteBar[] = [];
  let p = 100;
  let climbing = true;
  for (let m = 0; m <= 389; m++) {
    const o = p;
    if (climbing && p >= 102.8) {
      climbing = false;
      p = 102.98; // within a quarter unit of 103, not beyond it
    } else if (climbing) p = p * (1 + wiggle(m) * beta + 0.0008);
    else p = p * (1 - 0.001);
    const h = m === 1 ? 103 : Math.max(o, p);
    out.push({ m, o, h, l: Math.min(o, p), c: p, v: 2000 });
  }
  return out;
};

test("runner (live): a failed break at the day's high sells all, with the level in the note", async () => {
  const h = harness("live", {}, failedBreakDay);
  // Version 2.5 has the sale off; 2.4 has it.
  h.bot.setSettings(applyVersion(h.bot.settings(), "2.4.0"));
  await h.run(DAY, 565, 640);
  const [p] = h.store.recentPositions(DAY);
  assert.equal(p!.breakWatch?.name, "the day's high");
  assert.equal(p!.breakWatch?.level, 103);
  const sells = h.calls.filter((c) => c.kind === "sell");
  assert.equal(sells.length, 1);
  assert.equal(sells[0]!.body.qty, "33");
  assert.match(
    String(sells[0]!.body.note),
    /Failed break: reached the day's high \(103\.00\)/,
  );
  assert.ok(
    h.store.events(50).some((e) => /failed break: reached/.test(e.text)),
  );
  await h.run(DAY, 641, 645);
  assert.equal(h.store.openPositions().length, 0);
});

test("runner (live): with the failed-break sale off the bot only notes it and keeps the position", async () => {
  const h = harness("live", {}, failedBreakDay);
  // The strength-gone sale and the staged exit are off too: the falling stock would trip them.
  h.bot.setSettings({
    ...h.bot.settings(),
    sellFailedBreak: false,
    sellOnWeakness: false,
    stockStages: false,
  });
  await h.run(DAY, 565, 640);
  assert.equal(h.calls.filter((c) => c.kind === "sell").length, 0);
  assert.ok(
    h.store.events(50).some((e) => /failed-break sale is off/.test(e.text)),
  );
});

test("orders: the bot's buys chase the ask at any spread and its sales wait 10 minutes at the bid", async () => {
  const h = harness("live");
  await h.run(DAY, 565, 600);
  const buy = h.calls.find((c) => c.kind === "buy")!;
  assert.equal(buy.body.chase, true);
  assert.equal(buy.body.chaseMs, chaseBuyMs);
  assert.equal(buy.body.force, true);
  h.setMid(0.7);
  await h.run(DAY, 601, 955);
  const sell = h.calls.find((c) => c.kind === "sell")!;
  assert.equal(sell.body.waitMs, sellWaitMs);
});

test("exits run on every tick, between minutes, on the stock's last trade", async () => {
  // The bars keep climbing, but the stock's last trade is far below the
  // entry: the 10-minute check finds it against the entry on a tick 40 s
  // into its minute, not only on a minute's close.
  const live = new Map<string, number>();
  const h = harness("live");
  // 2.7's exits: the 10-minute check (2.8 has none).
  h.bot.setSettings(applyVersion(h.bot.settings(), "2.7.0"));
  (h.bot as unknown as { o: { market: BotMarket } }).o.market.lastPrices =
    async () => live;
  await h.run(DAY, 565, 585);
  const [p] = h.store.openPositions();
  assert.equal(p!.status, "open");
  const wall = 570 + p!.entryMinute + 10;
  assert.ok(wall > 585);
  live.set("NVDA", 90);
  await h.run(DAY, 586, wall - 1);
  assert.equal(h.calls.filter((c) => c.kind === "sell").length, 0);
  await h.tickAt(DAY, wall, 40);
  const sells = h.calls.filter((c) => c.kind === "sell");
  assert.equal(sells.length, 1);
  assert.match(String(sells[0]!.body.note), /10-min check/);
});

test("2.8: the staged exit sells on the stock's move against the signal price, with no 10-minute check", async () => {
  const live = new Map<string, number>();
  const h = harness("live");
  (h.bot as unknown as { o: { market: BotMarket } }).o.market.lastPrices =
    async () => live;
  await h.run(DAY, 565, 585);
  const [p] = h.store.openPositions();
  assert.equal(p!.status, "open");
  // Far below the signal price: many of the stock's usual 30-minute moves against the call.
  live.set("NVDA", p!.entryStock * 0.9);
  await h.tickAt(DAY, 586, 20);
  const sells = h.calls.filter((c) => c.kind === "sell");
  assert.equal(sells.length, 1);
  assert.match(String(sells[0]!.body.note), /Staged exit: .* sold all/);
  assert.doesNotMatch(String(sells[0]!.body.note), /10-min check/);
});

test("broker setting 'both': an account that throws does not undo the other's entry", async () => {
  const h = harness("live");
  h.bot.setSettings({ ...h.bot.settings(), broker: "both" });
  h.failIbkrBuy(true);
  await h.run(DAY, 565, 600);
  assert.deepEqual(
    h.store.openPositions().map((p) => [p.broker, p.qty]),
    [["alpaca", 33]],
  );
  // The signal counts as bought, and its words keep the IBKR error.
  const signal = h.store.signals(DAY)[0]!;
  assert.equal(signal.outcome, "bought");
  assert.match(
    signal.detail ?? "",
    /Alpaca: 33 .*; Interactive Brokers: market data requires additional subscription/,
  );
});

// ---- version 2.7: IBIT's floor, the pyramid, early entry (docs/tasks/backend-bot-champion.md) ----

test("picker 2.7: IBIT is bought down to $0.10, every other stock keeps the floor; no cheap fallback", () => {
  const s = applyVersion(defaultSettings, "2.7.0");
  assert.equal(pickRules(s, "IBIT").minPrice, 0.1);
  assert.equal(pickRules(s, "NVDA").minPrice, 0.2);
  assert.equal(pickRules(s, "NVDA").cheapFallback, false);
  // the 0.15-delta strike costs 0.13 (mid): IBIT takes it, another stock skips it (no fallback to 112)
  const chain = [q(115, 0.15, 0.12), q(112, 0.2, 0.2)];
  const ibit = pickContract(
    chain,
    102,
    "call",
    "2026-10-21",
    pickRules(s, "IBIT"),
  );
  assert.ok(ibit.ok);
  assert.equal(ibit.quote.strike, 115);
  const other = pickContract(
    chain,
    102,
    "call",
    "2026-10-21",
    pickRules(s, "NVDA"),
  );
  assert.equal(!other.ok && other.reason, "too_cheap");
  // under IBIT's own floor it is too cheap too
  const under = pickContract(
    [q(115, 0.15, 0.08)],
    102,
    "call",
    "2026-10-21",
    pickRules(s, "IBIT"),
  );
  assert.equal(!under.ok && under.reason, "too_cheap");
  // the owner's minimum still sets the floor of the other stocks
  assert.equal(pickRules({ ...s, minPrice: 0.15 }, "NVDA").minPrice, 0.15);
  assert.equal(pickRules({ ...s, minPrice: 0.15 }, "IBIT").minPrice, 0.1);
});

/** The minute of the harness day's NVDA signal (the full signal: t >= 1.8). */
async function signalMinute(): Promise<number> {
  const h = harness("live");
  await h.run(DAY, 565, 640);
  const sig = h.store.signals(DAY)[0];
  assert.ok(sig, "the harness day has a signal");
  return sig.minute;
}

/**
 * A harness whose NVDA D2 entry is already open: a signal row (so the day's
 * own entry passes) and a bonus position `before` minutes ahead of the full
 * signal, in the 110 call the add would pick too.
 */
async function withFirst(over: Partial<BotPosition> = {}, before = 3) {
  const M = await signalMinute();
  const h = harness("live");
  const contract = q(110, 0.15, 0.59).symbol;
  h.store.addSignal({
    day: DAY,
    symbol: "NVDA",
    right: "C",
    minute: M - before,
    t: 1.3,
    rvol: 2,
    outcome: "bought",
    detail: "",
    at: 0,
    version: "2.7",
  });
  const first: BotPosition = {
    id: "first",
    day: DAY,
    symbol: "NVDA",
    contract,
    right: "C",
    qty: 10,
    bought: 10,
    cost: 0.3,
    entryMinute: M - before,
    entryStock: 100,
    nights: 0,
    checksDone: [],
    morningDone: false,
    breakWatch: null,
    decidedOn: null,
    version: "2.7",
    broker: "alpaca",
    status: "open",
    jobId: null,
    dry: false,
    sales: [],
    openedAt: 0,
    closedAt: null,
    bonus: true,
    ...over,
  };
  h.store.savePosition(first);
  if (first.status === "open") h.held.set(contract, first.qty);
  return { h, M, contract };
}

test("pyramid: the full signal after a D2 entry that is up buys half a size more, once, in the same contract", async () => {
  const { h, M, contract } = await withFirst();
  await h.run(DAY, 565, 570 + M + 3);
  const buys = h.calls.filter((c) => c.kind === "buy");
  assert.equal(buys.length, 1, "one add");
  assert.equal(buys[0]!.body.sizePct, 1.5); // half of 3%
  assert.equal(buys[0]!.body.contract, contract);
  // The add passes the service's 60-second repeat check (user 2026-10-28).
  assert.deepEqual(buys[0]!.options, { repeatOk: true });
  assert.match(
    String(buys[0]!.body.note),
    /^Pyramid call at .*the full signal.*after the D2 entry.*50% of the size · bot 2\.10\.0$/,
  );
  const open = h.store.openPositions();
  const add = open.find((p) => p.addOf === "first");
  assert.ok(add, "the add is its own position");
  // the account holds 10 + 33: each position counts its own
  assert.equal(h.held.get(contract), 43);
  assert.equal(add!.qty, 33);
  assert.equal(open.find((p) => p.id === "first")!.qty, 10);
  assert.equal(open.find((p) => p.id === "first")!.pyramidChecked, true);
  // later minutes add nothing more
  await h.run(DAY, 570 + M + 4, 570 + M + 30);
  assert.equal(h.calls.filter((c) => c.kind === "buy").length, 1);
});

test("pyramid: no add when the first position is not up, is the other side, is not a D2 entry, or the version has no pyramid", async () => {
  const down = await withFirst({ cost: 1.0 }); // the quote's mid is 0.6
  await down.h.run(DAY, 565, 570 + down.M + 3);
  assert.equal(down.h.calls.filter((c) => c.kind === "buy").length, 0);
  assert.equal(down.h.store.openPositions()[0]!.pyramidChecked, true);
  assert.match(
    down.h.bot
      .status()
      .activity.map((e) => e.text)
      .join("\n"),
    /NVDA pyramid: the first position is not up/,
  );
  const put = await withFirst({ right: "P" });
  // kept open past the full signal: no strength exit, no timed checks, no staged exit (the stock rises against a put)
  put.h.bot.setSettings({
    ...put.h.bot.settings(),
    sellOnWeakness: false,
    checks: false,
    stockStages: false,
  });
  await put.h.run(DAY, 565, 570 + put.M + 3);
  assert.equal(put.h.calls.filter((c) => c.kind === "buy").length, 0);
  assert.match(
    put.h.bot
      .status()
      .activity.map((e) => e.text)
      .join("\n"),
    /NVDA pyramid: the full signal at .* is the other side/,
  );
  const plain = await withFirst({ bonus: false });
  await plain.h.run(DAY, 565, 570 + plain.M + 3);
  assert.equal(plain.h.calls.filter((c) => c.kind === "buy").length, 0);
  const off = await withFirst();
  off.h.bot.setSettings({ ...off.h.bot.settings(), pyramid: false });
  await off.h.run(DAY, 565, 570 + off.M + 3);
  assert.equal(off.h.calls.filter((c) => c.kind === "buy").length, 0);
});

test("pyramid: never buys more of a contract the user holds; the shared contract never counts more than the account holds", async () => {
  // the account holds 15 of the contract, the bot's first position 10: 5 are the user's
  const { h, M, contract } = await withFirst();
  h.held.set(contract, 15);
  await h.run(DAY, 565, 570 + M + 3);
  assert.equal(h.calls.filter((c) => c.kind === "buy").length, 0);
  assert.match(
    h.bot
      .status()
      .activity.map((e) => e.text)
      .join("\n"),
    /NVDA pyramid: skipped, you hold this contract/,
  );
  // two bot positions in one contract, then the account loses some (a stop or a sale by hand)
  const shared = await withFirst();
  await shared.h.run(DAY, 565, 570 + shared.M + 3);
  assert.equal(shared.h.held.get(shared.contract), 43);
  shared.h.held.set(shared.contract, 30);
  await shared.h.run(DAY, 570 + shared.M + 4, 570 + shared.M + 4);
  const counted = shared.h.store
    .openPositions()
    .filter((p) => p.contract === shared.contract)
    .reduce((n, p) => n + p.qty, 0);
  assert.ok(counted <= 30, `the bot counts ${counted}, the account holds 30`);
});

test("early entry: the signal inside the minute buys before the minute closes; off, it waits for the close", async () => {
  const M = await signalMinute();
  // the stock's latest trade inside a minute is that minute's close (synthetic)
  const withPrices = (h: ReturnType<typeof harness>) => {
    const market = (h.bot as any).o.market;
    market.lastPrices = async (symbols: string[]) => {
      const now = (h.bot as any).o.now();
      const minute = Math.floor((now - at(DAY, 570, 0)) / 60_000);
      const out = new Map<string, number>();
      for (const s of symbols) {
        const day = await market.bars([s], DAY, minute, minute);
        const bar = day.get(s)?.[0];
        if (bar) out.set(s, bar.c);
      }
      return out;
    };
  };
  const early = harness("live");
  withPrices(early);
  await early.run(DAY, 565, 570 + M - 1);
  await early.tickAt(DAY, 570 + M, 25); // inside minute M, before it closes
  const sig = early.store.signals(DAY)[0];
  assert.ok(sig, "a signal inside the minute");
  assert.equal(sig!.minute, M);
  assert.equal(early.calls.filter((c) => c.kind === "buy").length, 1);
  assert.match(
    early.bot
      .status()
      .activity.map((e) => e.text)
      .join("\n"),
    /NVDA call signal at .*:25, inside the minute/,
  );
  // the closed minute finds the signal taken and buys nothing more
  await early.run(DAY, 570 + M + 1, 570 + M + 3);
  assert.equal(early.calls.filter((c) => c.kind === "buy").length, 1);
  // the live bars request already holds the forming minute (its part so far): still the closed minutes plus the latest trade
  const forming = harness("live");
  withPrices(forming);
  const market = (forming.bot as any).o.market;
  const bars = market.bars.bind(market);
  market.bars = (s: string[], d: string, from: number, to: number) =>
    bars(s, d, from, to + 1);
  await forming.run(DAY, 565, 570 + M - 1);
  await forming.tickAt(DAY, 570 + M, 25);
  assert.equal(forming.store.signals(DAY)[0]?.minute, M);
  assert.equal(forming.calls.filter((c) => c.kind === "buy").length, 1);
  const late = harness("live");
  withPrices(late);
  late.bot.setSettings({ ...late.bot.settings(), earlyEntry: false });
  await late.run(DAY, 565, 570 + M - 1);
  await late.tickAt(DAY, 570 + M, 25);
  assert.equal(late.calls.filter((c) => c.kind === "buy").length, 0);
  await late.tickAt(DAY, 570 + M + 1, 20);
  assert.equal(late.calls.filter((c) => c.kind === "buy").length, 1);
});

test("2.10: the size follows the signal's volume tier, with the share in the buy note; no tiers is the whole size", async () => {
  // The harness's signal runs at 2.0x volume: 2.10's 1.75-2.5x tier, the whole size.
  const full = harness("live");
  full.setEquity(100_000);
  await full.run(DAY, 565, 600);
  assert.equal(full.calls.find((c) => c.kind === "buy")?.body.sizePct, 3);
  assert.equal(full.store.openPositions()[0]?.sizeShare, undefined);
  // Tiers that put 2.0x under the first line above 0: half the size, kept on the position.
  const half = harness("live");
  half.setEquity(100_000);
  half.bot.setSettings({
    ...half.bot.settings(),
    volumeTiers: [
      { atLeast: 0, pct: 50 },
      { atLeast: 2.5, pct: 150 },
    ],
  });
  await half.run(DAY, 565, 600);
  assert.equal(half.calls.find((c) => c.kind === "buy")?.body.sizePct, 1.5);
  assert.equal(half.store.openPositions()[0]?.sizeShare, 0.5);
  assert.match(
    String(half.calls.find((c) => c.kind === "buy")?.body.note),
    /50% of the size \(volume 2\.00×\)/,
  );
  // A big-volume tier: one and a half times the size (4.5%, under the 5% cap per buy).
  const big = harness("live");
  big.setEquity(100_000);
  big.bot.setSettings({
    ...big.bot.settings(),
    volumeTiers: [
      { atLeast: 0, pct: 50 },
      { atLeast: 1.5, pct: 150 },
    ],
  });
  await big.run(DAY, 565, 600);
  assert.equal(big.calls.find((c) => c.kind === "buy")?.body.sizePct, 4.5);
  // No tiers: the whole size.
  const off = harness("live");
  off.setEquity(100_000);
  off.bot.setSettings({ ...off.bot.settings(), volumeTiers: [] });
  await off.run(DAY, 565, 600);
  assert.equal(off.calls.find((c) => c.kind === "buy")?.body.sizePct, 3);
});

test("2.10: a 150% buy a risk limit refuses buys the whole size instead; no pyramid add after a 150% first leg", async () => {
  const h = harness("live");
  h.setEquity(100_000);
  h.bot.setSettings({
    ...h.bot.settings(),
    volumeTiers: [
      { atLeast: 0, pct: 50 },
      { atLeast: 1.5, pct: 150 },
    ],
  });
  // The service refuses anything over 4% (a stand-in for a risk limit).
  h.refuseOver(4);
  await h.run(DAY, 565, 600);
  const buys = h.calls.filter((c) => c.kind === "buy");
  assert.deepEqual(
    buys.map((c) => c.body.sizePct),
    [4.5, 3],
  );
  assert.match(
    String(buys[1]?.body.note),
    /150% refused \(.*\), bought the whole size/,
  );
  assert.equal(h.store.openPositions()[0]?.sizeShare, 1);
});

test("2.10: an early entry's volume ratio compares the minutes before the forming one", async () => {
  const { cSignal } = await import("../packages/trading/src/bot/signal.js");
  // 20 prior days of 100 shares a minute; today 200 a minute through minute 29, the forming minute 30 with none yet.
  const bar = (m: number, c: number, v: number) => ({
    m,
    o: c,
    h: c,
    l: c,
    c,
    v,
  });
  const flat = (v: number, upTo = 389) =>
    Array.from({ length: upTo + 1 }, (_, m) => bar(m, 100, v));
  const prior = {
    curves: Array.from({ length: 20 }, () =>
      Array.from({ length: 390 }, (_, m) => 100 * (m + 1)),
    ),
    beta: 1,
    unit: null,
    sd: null,
    lastClose: 100,
  };
  const day = flat(200, 29).map((b, m) => ({ ...b, c: 100 + m * 0.05 }));
  const forming = [...day, bar(30, 100 + 30 * 0.05, 0)];
  const spy = flat(100, 30);
  const p = {
    ...defaultSignalParams,
    firstMinute: 10,
    minSteps: 5,
    strengthT: 0,
    bonusT: null,
  };
  const closed = cSignal(forming, spy, prior as never, 30, p);
  const early = cSignal(forming, spy, prior as never, 30, p, true);
  // Through minute 29 today is 2x the usual through minute 29.
  assert.ok(early, "the forming minute's signal");
  assert.ok(Math.abs(early.rvol - 2) < 1e-9, String(early.rvol));
  if (closed && closed.minute === 30) assert.ok(closed.rvol < early!.rvol);
});
