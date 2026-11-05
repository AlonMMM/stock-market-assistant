// SYNTHETIC market data, chains and fills: the Main bot's backtest on the
// Backtest page (packages/trading/src/bot/backtest.ts, backtest-account.ts).
// On real bars the trades were checked by hand against the Python replay
// (week.py, research/indi-v2) with scripts/bot-backtest-run.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  D1OptionQuotes,
  mergeSources,
} from "../packages/market-data/src/option-quotes.js";
import { D1OptionBars } from "../packages/market-data/src/option-bars.js";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";
import {
  AlpacaBacktestData,
  backtestCalendar,
} from "../packages/market-data/src/bot-backtest.js";
import { previousSessions } from "../packages/market-data/src/calendar.js";
import {
  impliedDelta,
  runStock,
  defaultFillPct,
  bookAt,
  type BacktestData,
  type ChainContract,
  type SimStep,
  type SimTrade,
} from "../packages/trading/src/bot/backtest.js";
import {
  defaultMoney,
  runAccount,
} from "../packages/trading/src/bot/backtest-account.js";
import { defaultSettings } from "../packages/trading/src/bot/settings.js";
import {
  currentVersion,
  versionById,
} from "../packages/trading/src/bot/versions.js";
import { defaultExitRules } from "../packages/trading/src/bot/exits.js";
import type { MinuteBar } from "../packages/trading/src/bot/signal.js";
import {
  clockText,
  nightsHeld,
  signalRows,
  skipStory,
  sortSignals,
  sortTrades,
  paperSetup,
  parseTickers,
  periodParts,
  runClock,
  periodRange,
  sessionsBetween,
  stocksLabel,
  tradeSize,
} from "../apps/web/src/bot-backtest-model.js";
import {
  mainRun,
  runState,
  startRun,
  stopRun,
} from "../apps/web/src/bot-backtest-run.js";
import {
  changeText,
  isCurrentSummary,
  mainRuleChanges,
  mainRunSummary,
  periodDates,
  periodName,
} from "../apps/web/src/backtest-history-model.js";
import {
  BacktestJobs,
  handleBacktestJobs,
  runPart,
  type PartTask,
} from "../packages/market-data/src/backtest-jobs.js";

const step = (
  date: string,
  minute: number,
  kind: SimStep["kind"],
  share: number,
  price: number,
  reason: SimStep["reason"],
): SimStep => ({
  date,
  minute,
  kind,
  share,
  price,
  reason,
});

function trade(
  id: string,
  date: string,
  steps: SimStep[],
  extra: Partial<SimTrade> = {},
): SimTrade {
  return {
    id,
    symbol: "NVDA",
    contract: "NVDA260904C00235000",
    right: "C",
    date,
    minute: steps[0]!.minute - 1,
    t: 2,
    rvol: 2,
    d2: null,
    bonus: false,
    pyramid: false,
    sizeShare: 1,
    stock: 100,
    strike: 105,
    expiry: "2026-09-04",
    delta: 0.15,
    volume30: 500,
    fallback: false,
    steps,
    open: false,
    priced: "trades",
    watch: null,
    ...extra,
  };
}

const money = { ...defaultMoney, nightCapPct: 0 };

test("the account sizes each trade from the day's start and pays a fee each way", () => {
  const t = trade("a", "2026-09-02", [
    step("2026-09-02", 11, "buy", 1, 0.5, "entry"),
    step("2026-09-02", 21, "sell", 0.5, 0.4, "check-10"),
    step("2026-09-02", 31, "sell", 0.5, 0.3, "check-20"),
  ]);
  const r = runAccount([t], money);
  const a = r.trades[0]!;
  // 2% of $100,000 = $2,000; at $0.50 a contract ($50) that is 40 contracts.
  assert.equal(a.qty, 40);
  assert.equal(a.paid, 2000);
  assert.deepEqual(
    a.fills.map((f) => f.qty),
    [40, 20, 20],
  );
  assert.equal(a.proceeds, 20 * 40 + 20 * 30);
  assert.equal(a.fees, 80 * 0.62);
  assert.equal(
    Number(a.pnl.toFixed(2)),
    Number((1400 - 2000 - 49.6).toFixed(2)),
  );
  assert.equal(Number(r.end.toFixed(2)), Number((100000 + a.pnl).toFixed(2)));
  assert.equal(r.taken, 1);
  assert.equal(r.losses, 1);
});

test("a trade's size: the volume tier or the pyramid, and its % of the account it was sized from", () => {
  const rules = defaultSettings; // 1.75× and 2.5× volume tiers
  const buy = [
    step("2026-09-02", 11, "buy", 1, 0.5, "entry"),
    step("2026-09-02", 31, "sell", 1, 0.6, "close-1550"),
  ];
  const r = runAccount(
    [
      trade("big", "2026-09-02", buy, { rvol: 3, sizeShare: 1.5 }),
      trade(
        "half",
        "2026-09-03",
        buy.map((x) => ({ ...x, date: "2026-09-03" })),
        {
          rvol: 1.2,
          sizeShare: 0.5,
        },
      ),
      trade(
        "pyr",
        "2026-09-04",
        buy.map((x) => ({ ...x, date: "2026-09-04" })),
        {
          pyramid: true,
          sizeShare: 0.75,
        },
      ),
    ],
    { ...money, feePerContract: 0 },
  );
  const [big, half, pyr] = r.trades.map((a) => tradeSize(a, rules));
  assert.equal(r.trades[0]!.basis, 100_000);
  assert.equal(r.trades[0]!.targetPct, 3); // 2% × 150%
  assert.equal(big!.kind, "big");
  assert.equal(big!.label, "Big size ×1.5");
  assert.equal(big!.pct, 3); // 60 contracts at $0.50
  assert.match(big!.why, /3\.00× its usual \(from 2\.5×: 150% of the size\)/);
  assert.equal(half!.label, "Half size");
  assert.match(half!.why, /under 1\.75×: 50%/);
  assert.equal(pyr!.kind, "pyramid");
  assert.match(pyr!.why, /pyramid's add/);
});

test("the account refuses a buy over the open positions and the day's buys", () => {
  const day = "2026-09-02";
  const held = (id: string, at: number) =>
    trade(id, day, [
      step(day, at, "buy", 1, 1, "entry"),
      step(day, 300, "sell", 1, 1.1, "close-1550"),
    ]);
  const r1 = runAccount([held("a", 11), held("b", 12), held("c", 13)], {
    ...money,
    maxOpen: 2,
  });
  assert.deepEqual(
    r1.trades.map((a) => a.status),
    ["taken", "taken", "open-limit"],
  );
  const quick = (id: string, at: number) =>
    trade(id, day, [
      step(day, at, "buy", 1, 1, "entry"),
      step(day, at + 1, "sell", 1, 1, "stop-30"),
    ]);
  const r2 = runAccount([quick("a", 11), quick("b", 20), quick("c", 30)], {
    ...money,
    maxBuysPerDay: 2,
  });
  assert.deepEqual(
    r2.trades.map((a) => a.status),
    ["taken", "taken", "day-limit"],
  );
});

test("with the limits off the account takes every buy and holds the night uncapped", () => {
  const day = (id: string, m: number) =>
    trade(id, "2026-09-02", [
      step("2026-09-02", m, "buy", 1, 0.5, "entry"),
      step("2026-09-02", 380, "sell", 1, 0.5, "close-1550"),
    ]);
  const many = ["a", "b", "c", "d", "e", "f", "g"].map((id, i) =>
    day(id, 11 + i),
  );
  const limited = runAccount(many, money);
  assert.ok(limited.trades.some((a) => a.status !== "taken"));
  const free = runAccount(many, {
    ...money,
    maxBuysPerDay: Infinity,
    maxOpen: Infinity,
    nightCapPct: 0,
  });
  assert.equal(free.taken, 7);
});

test("the overnight cap sells what is worth more than its share of the account", () => {
  const t = trade("a", "2026-09-02", [
    step("2026-09-02", 11, "buy", 1, 1, "entry"),
    step("2026-09-02", 380, "carry", 1, 10, "carry"),
    step("2026-09-03", 11, "sell", 0.5, 12, "morning-gap-keep"),
    step("2026-09-03", 300, "sell", 0.5, 11, "close-1550"),
  ]);
  // 20 contracts at $10 = $20,000 held tonight; the cap is 10% of $100,000.
  const r = runAccount([t], { ...money, nightCapPct: 10, feePerContract: 0 });
  const a = r.trades[0]!;
  assert.equal(a.qty, 20);
  const cap = a.fills.find((f) => f.reason === "night-cap")!;
  assert.equal(cap.qty, 10);
  assert.equal(cap.price, 10 * 0.98);
  // What is left (10) is sold half and half the next day.
  assert.deepEqual(
    a.fills.filter((f) => f.date === "2026-09-03").map((f) => f.qty),
    [5, 5],
  );
});

test("the implied delta of an out-of-the-money call is small and grows toward the money", () => {
  const far = impliedDelta(0.3, 100, 110, 3 / 365, true)!;
  const near = impliedDelta(1.5, 100, 101, 3 / 365, true)!;
  assert.ok(far > 0 && far < near && near < 0.6, `${far} ${near}`);
  assert.equal(impliedDelta(99, 100, 150, 3 / 365, true), null);
});

// ---- one stock through runStock, on made-up bars ----

const date = "2026-09-02";
const priorDates = previousSessions(date, 25);
// A repeatable wiggle, so beta and the volume curves have something to measure.
const wiggle = (i: number) =>
  Math.sin(i * 1.7) * 0.0006 + Math.cos(i * 0.31) * 0.0004;

function flatDay(
  seed: number,
  start: number,
  volume: number,
  beta = 1,
): { stock: MinuteBar[]; spy: MinuteBar[] } {
  const stock: MinuteBar[] = [];
  const spy: MinuteBar[] = [];
  let s = start;
  let p = 500;
  for (let m = 0; m < 390; m++) {
    const move = wiggle(seed * 390 + m);
    p *= 1 + move;
    s *= 1 + beta * move + wiggle(seed * 777 + m) * 0.5;
    spy.push({ m, o: p, h: p, l: p, c: p, v: 1000 });
    stock.push({ m, o: s, h: s * 1.0005, l: s * 0.9995, c: s, v: volume });
  }
  return { stock, spy };
}

function fakeData(premarket: number): {
  data: BacktestData;
  spot: () => number;
} {
  const bars = new Map<string, MinuteBar[]>();
  priorDates.forEach((d, i) => {
    const day = flatDay(i + 1, 100, 1000);
    bars.set(`NVDA|${d}`, day.stock);
    bars.set(`SPY|${d}`, day.spy);
  });
  // Today: SPY wiggles, the stock climbs steadily on twice the volume.
  const today = flatDay(99, 100, 2000);
  const stock = today.stock.map((b) => {
    const c = 100 * (1 + 0.0004 * b.m);
    return { ...b, o: c, h: c * 1.0003, l: c * 0.9997, c };
  });
  bars.set(`NVDA|${date}`, stock);
  bars.set(`SPY|${date}`, today.spy);
  const strikes = [101, 102, 103, 104, 105, 106, 107, 108];
  const chain: ChainContract[] = strikes.map((k) => ({
    symbol: `NVDA260904C00${k}000`,
    expiry: "2026-09-04",
    strike: k,
  }));
  // Prices fall with the strike; the option keeps its price after the buy.
  const priceOf = (k: number) => 3 * Math.exp(-(k - 100) / 3);
  const optionBars = (k: number): MinuteBar[] =>
    Array.from({ length: 390 }, (_, m) => {
      const c = priceOf(k);
      return { m, o: c, h: c * 1.02, l: c * 0.98, c, v: 50 };
    });
  const data: BacktestData = {
    lastSession: date,
    bars: (symbol, d) => bars.get(`${symbol}|${d}`) ?? [],
    premarket: (symbol, d) => (d === date ? premarket : 1000),
    chain: async () => chain,
    optionDay: async (contracts) =>
      new Map(contracts.map((c) => [c, optionBars(Number(c.slice(-8, -3)))])),
    optionRange: async (contract) =>
      new Map([[date, optionBars(Number(contract.slice(-8, -3)))]]),
    earnings: async () => [],
  };
  return { data, spot: () => stock[10]!.c };
}

test("a stock's run buys the signal's contract on the next bar and sells it by the day's end", async () => {
  const { data } = fakeData(1000);
  const run = await runStock(
    "NVDA",
    [date],
    { ...defaultSettings, pyramid: false },
    data,
    backtestCalendar,
    {
      fillPct: 2,
    },
  );
  assert.equal(run.skips.length, 0, JSON.stringify(run.skips));
  assert.equal(run.trades.length, 1);
  const t = run.trades[0]!;
  assert.equal(t.right, "C");
  assert.equal(t.minute, defaultSettings.firstEntryMin);
  const buy = t.steps[0]!;
  assert.equal(buy.kind, "buy");
  assert.equal(buy.minute, t.minute + 1);
  // The bar's middle plus the 2% fill cost.
  const k = t.strike;
  assert.ok(Math.abs(buy.price - 3 * Math.exp(-(k - 100) / 3) * 1.02) < 1e-9);
  const sold = t.steps
    .filter((s) => s.kind === "sell")
    .reduce((n, s) => n + s.share, 0);
  assert.ok(Math.abs(sold - 1) < 1e-9);
  // The option never moved and the stock kept climbing: no stop, sold at 15:50.
  assert.equal(t.steps.at(-1)!.reason, "close-1550");
  assert.equal(t.priced, "trades");
});

test("a thin option with no quotes: bought at its first print, however late, and checked every stock minute", async () => {
  const { data } = fakeData(1000);
  const signal = defaultSettings.firstEntryMin;
  // The option prints 10 minutes after the signal, then once at minute 200.
  const thin: BacktestData = {
    ...data,
    optionRange: async (contract, from, to) => {
      const all = await data.optionRange(contract, from, to);
      return new Map(
        [...all].map(([d, bars]) => [
          d,
          bars.filter((b) => b.m === signal + 10 || b.m === 200),
        ]),
      );
    },
  };
  const run = await runStock(
    "NVDA",
    [date],
    { ...defaultSettings, pyramid: false },
    thin,
    backtestCalendar,
    { fillPct: 2 },
  );
  assert.equal(run.skips.length, 0, JSON.stringify(run.skips));
  const t = run.trades[0]!;
  assert.equal(t.steps[0]!.minute, signal + 10);
  // The 15:50 decision runs at 15:50 on the last trade, not at the last print (minute 200).
  const last = t.steps.at(-1)!;
  assert.equal(last.reason, "close-1550");
  assert.equal(last.minute, defaultExitRules.eodMinute + 1);
});

test("2.8 in the backtest: the staged exit sells when the stock falls against the signal price", async () => {
  const { data } = fakeData(1000);
  const signal = defaultSettings.firstEntryMin;
  // After the buy the stock drops 2% (many of its usual 30-minute moves) and
  // stays there; the strength exit is off so the staged exit is what is tested.
  const falling: BacktestData = {
    ...data,
    bars: (symbol, d) => {
      const bars = data.bars(symbol, d);
      if (symbol !== "NVDA" || d !== date) return bars;
      return bars.map((b) =>
        b.m > signal + 5
          ? { ...b, o: b.o * 0.98, h: b.h * 0.98, l: b.l * 0.98, c: b.c * 0.98 }
          : b,
      );
    },
  };
  const run = await runStock(
    "NVDA",
    [date],
    { ...defaultSettings, pyramid: false, sellOnWeakness: false },
    falling,
    backtestCalendar,
    { fillPct: 2 },
  );
  const t = run.trades[0]!;
  const reasons = t.steps.filter((x) => x.kind === "sell").map((x) => x.reason);
  assert.ok(reasons.includes("stage-full"), reasons.join(","));
  assert.ok(!reasons.includes("check-10"), reasons.join(","));
  // With 2.7's rules the same day goes through the 10-minute check instead.
  const old = await runStock(
    "NVDA",
    [date],
    {
      ...defaultSettings,
      pyramid: false,
      sellOnWeakness: false,
      checks: true,
      stockStages: false,
      stopPct: 30,
    },
    falling,
    backtestCalendar,
    { fillPct: 2 },
  );
  const oldReasons = old.trades[0]!.steps.filter((x) => x.kind === "sell").map(
    (x) => x.reason,
  );
  assert.ok(oldReasons.includes("check-10"), oldReasons.join(","));
});

/** The fake data with a real book every minute for every contract: the bar's price -/+ a cent. */
function withQuotes(
  data: BacktestData,
  book = (k: number, m: number) => {
    const p = 3 * Math.exp(-(k - 100) / 3);
    return { m, bid: p - 0.01, ask: p + 0.01 };
  },
): BacktestData {
  return {
    ...data,
    optionQuotes: async (contract) =>
      new Map([
        [
          date,
          Array.from({ length: 390 }, (_, m) =>
            book(Number(contract.slice(-8, -3)), m),
          ),
        ],
      ]),
  };
}

test("with real quotes: the buy pays the mid + a quarter of the spread at the signal, the sale gets the bid", async () => {
  const { data } = fakeData(1000);
  const run = await runStock(
    "NVDA",
    [date],
    { ...defaultSettings, pyramid: false },
    withQuotes(data),
    backtestCalendar,
    { fillPct: 2 },
  );
  const t = run.trades[0]!;
  assert.equal(t.priced, "quotes");
  const p = 3 * Math.exp(-(t.strike - 100) / 3);
  const buy = t.steps[0]!;
  assert.equal(buy.minute, t.minute);
  // mid + a quarter of the 2-cent spread; no fill cost on real quotes
  assert.ok(Math.abs(buy.price - (p + 0.005)) < 1e-9, String(buy.price));
  const last = t.steps.at(-1)!;
  assert.equal(last.reason, "close-1550");
  assert.ok(Math.abs(last.price - (p - 0.01)) < 1e-9, String(last.price));
  // Each fill keeps the book it was priced on, for the trade window.
  assert.ok(Math.abs(buy.book!.ask - buy.book!.bid - 0.02) < 1e-9);
  assert.ok(Math.abs(last.book!.bid - last.price) < 1e-9);
  const a = runAccount([t], money).trades[0]!;
  assert.deepEqual(a.fills[0]!.book, buy.book);
  assert.deepEqual(a.fills.at(-1)!.book, last.book);
});

test("with real quotes: the bid running past the price makes the buy pay the ask a minute later", async () => {
  const { data } = fakeData(1000);
  const run = await runStock(
    "NVDA",
    [date],
    { ...defaultSettings, pyramid: false },
    withQuotes(data, (k, m) => {
      const p = 3 * Math.exp(-(k - 100) / 3);
      const jump = m > defaultSettings.firstEntryMin ? 0.2 : 0;
      return { m, bid: p + jump - 0.01, ask: p + jump + 0.01 };
    }),
    backtestCalendar,
  );
  const t = run.trades[0]!;
  const p = 3 * Math.exp(-(t.strike - 100) / 3);
  assert.ok(Math.abs(t.steps[0]!.price - (p + 0.21)) < 1e-9);
  // The buy's book is the one it paid the ask of, a minute after the signal's.
  assert.ok(Math.abs(t.steps[0]!.book!.ask - t.steps[0]!.price) < 1e-9);
  assert.ok(Math.abs(t.book!.ask - (p + 0.01)) < 1e-9);
});

test("with only the bots' saved books (a few minutes): once the books are over, the 15:50 sale is on the trade bars, as the research", async () => {
  const { data } = fakeData(1000);
  const signal = defaultSettings.firstEntryMin;
  const sparse: BacktestData = {
    ...data,
    optionQuotes: async (contract) => {
      const p = 3 * Math.exp(-(Number(contract.slice(-8, -3)) - 100) / 3);
      return new Map([
        [
          date,
          [
            { m: signal, bid: p - 0.01, ask: p + 0.01 },
            { m: 375, bid: p - 0.05, ask: p + 0.05 },
          ],
        ],
      ]);
    },
  };
  const run = await runStock(
    "NVDA",
    [date],
    { ...defaultSettings, pyramid: false },
    sparse,
    backtestCalendar,
  );
  const t = run.trades[0]!;
  assert.equal(t.priced, "quotes");
  const p = 3 * Math.exp(-(t.strike - 100) / 3);
  // No fresh book can come after 15:49 (the last is 15:45): the 15:50 sale
  // fills on the next minute's trade bar middle less the fill cost, as sim.py does.
  const last = t.steps.at(-1)!;
  assert.equal(last.minute, 380);
  const bars = await data.optionRange(t.contract, date, date);
  const bar = bars.get(date)!.find((b) => b.m === 381)!;
  const want = ((bar.h + bar.l) / 2) * (1 - defaultFillPct / 100);
  assert.ok(Math.abs(last.price - want) < 1e-9, String(last.price));
  assert.ok(p > 0);
});

test("the book as a minute closed: the newest at or before it, at most 5 minutes old", () => {
  const day = [
    { m: 10, bid: 1, ask: 1.1 },
    { m: 12, bid: 2, ask: 2.1 },
  ];
  assert.equal(bookAt(day, 9), null);
  assert.equal(bookAt(day, 11)?.bid, 1);
  assert.equal(bookAt(day, 16)?.bid, 2);
  assert.equal(bookAt(day, 17), null);
});

test("quote sources: the bots' saved books win over Databento's on the same minute; bad books are dropped", () => {
  const day = mergeSources([
    { source: "live", quotes: [[5, 0.11, 0.12]] },
    {
      source: "databento",
      quotes: [
        [4, 0.1, 0.13],
        [5, 0.09, 0.14],
        [6, 0.2, 0.1],
      ],
    },
  ]);
  assert.deepEqual(day, [
    { m: 4, bid: 0.1, ask: 0.13 },
    { m: 5, bid: 0.11, ask: 0.12 },
  ]);
});

test("a busy pre-market skips the signal when the news filter is on", async () => {
  const { data } = fakeData(5000);
  const run = await runStock(
    "NVDA",
    [date],
    defaultSettings,
    data,
    backtestCalendar,
  );
  assert.equal(run.trades.length, 0);
  assert.equal(run.skips[0]?.reason, "premarket");
  const off = await runStock(
    "NVDA",
    [date],
    { ...defaultSettings, skipPremarket: false, pyramid: false },
    data,
    backtestCalendar,
  );
  assert.equal(off.trades.length, 1);
});

test("a skipped signal keeps what the bot saw and the trade it would have made on Black-Scholes prices", async () => {
  const { data } = fakeData(5000);
  const run = await runStock(
    "NVDA",
    [date],
    { ...defaultSettings, pyramid: false },
    data,
    backtestCalendar,
  );
  const skip = run.skips[0]!;
  assert.equal(skip.reason, "premarket");
  assert.ok(skip.t! > 0 && skip.rvol! > 0 && skip.stock! > 0);
  // The contract it would have bought, though the news filter stopped it.
  const off = await runStock(
    "NVDA",
    [date],
    { ...defaultSettings, skipPremarket: false, pyramid: false },
    data,
    backtestCalendar,
  );
  assert.equal(skip.contract?.symbol, off.trades[0]!.contract);
  assert.equal(skip.contract?.volume30, 550); // 11 minutes of 50 since the open
  const w = skip.whatIf!;
  assert.equal(w.contract, skip.contract!.symbol);
  assert.equal(w.ivFrom, "option");
  assert.equal(w.modelled, false);
  assert.equal(w.steps[0]!.kind, "buy");
  // The stock climbs all day, so the modelled call gains.
  assert.ok(w.ret > 0, String(w.ret));
});

test("the real book at the signal is kept on a trade and on a skip's contract", async () => {
  const { data } = fakeData(5000);
  const quoted = withQuotes(data);
  const skip = (
    await runStock(
      "NVDA",
      [date],
      { ...defaultSettings, pyramid: false },
      quoted,
      backtestCalendar,
    )
  ).skips[0]!;
  const k = skip.contract!.strike;
  const p = 3 * Math.exp(-(k - 100) / 3);
  assert.ok(Math.abs(skip.contract!.book!.bid - (p - 0.01)) < 1e-9);
  const trade = (
    await runStock(
      "NVDA",
      [date],
      { ...defaultSettings, skipPremarket: false, pyramid: false },
      quoted,
      backtestCalendar,
    )
  ).trades[0]!;
  assert.ok(
    Math.abs(
      trade.book!.ask - (3 * Math.exp(-(trade.strike - 100) / 3) + 0.01),
    ) < 1e-9,
  );
  assert.ok(trade.signalPrice! > 0);
  // Without real quotes there is no book.
  const bare = (
    await runStock(
      "NVDA",
      [date],
      { ...defaultSettings, skipPremarket: false, pyramid: false },
      data,
      backtestCalendar,
    )
  ).trades[0]!;
  assert.equal(bare.book, undefined);
});

test("a thin contract's skip keeps its volume; with no expiry the what-if models a strike from the stock's volatility", async () => {
  const { data } = fakeData(1000);
  const thin = await runStock(
    "NVDA",
    [date],
    { ...defaultSettings, pyramid: false, minVolume: 5000 },
    data,
    backtestCalendar,
  );
  assert.equal(thin.trades.length, 0);
  assert.equal(thin.skips[0]?.reason, "illiquid");
  assert.equal(thin.skips[0]?.contract?.volume30, 550); // 11 minutes of 50 since the open
  assert.ok(thin.skips[0]?.whatIf);
  const none = await runStock(
    "NVDA",
    [date],
    { ...defaultSettings, pyramid: false },
    { ...data, chain: async () => [] },
    backtestCalendar,
  );
  const skip = none.skips[0]!;
  assert.equal(skip.reason, "no_expiry");
  assert.equal(skip.contract, undefined);
  assert.equal(skip.whatIf?.modelled, true);
  assert.equal(skip.whatIf?.ivFrom, "stock");
  // An out-of-the-money call at about the target delta
  assert.ok(skip.whatIf!.strike > skip.stock!, String(skip.whatIf!.strike));
});

test("the backtest reads Databento's quotes only, never the live bot's saved books", async () => {
  const db = new SqliteD1(":memory:");
  const store = new D1OptionQuotes(db);
  await store.get("X", date, date); // makes the table
  const put = (source: string, quotes: number[][]) =>
    db
      .prepare(
        "INSERT INTO option_quotes (contract, date, source, quotes, stored_at) VALUES (?, ?, ?, ?, 0)",
      )
      .bind("IBIT261102C00045500", date, source, JSON.stringify(quotes))
      .run();
  await put("databento", [[5, 0.1, 0.12]]);
  await put("live", [
    [5, 0.12, 0.13],
    [6, 0.11, 0.12],
  ]);
  const day = (await store.get("IBIT261102C00045500", date, date)).get(date);
  assert.deepEqual(day, [{ m: 5, bid: 0.1, ask: 0.12 }]);
  // A day with only the live bot's books has no quotes for the backtest.
  await db
    .prepare("DELETE FROM option_quotes WHERE source = 'databento'")
    .run();
  assert.equal((await store.get("IBIT261102C00045500", date, date)).size, 0);
});

test("the option data calls fetch unbound, as Cloudflare Workers require", async () => {
  // Workers throw "Illegal invocation" when fetch runs with a foreign `this`.
  const fetcher = function (this: unknown, input: URL) {
    if (this !== undefined && this !== globalThis)
      throw new TypeError("Illegal invocation");
    if (input.pathname === "/v2/options/contracts")
      return Promise.resolve(
        Response.json({
          option_contracts: [
            {
              symbol: "NVDA260904C00105000",
              expiration_date: "2026-09-04",
              strike_price: "105",
            },
          ],
          next_page_token: null,
        }),
      );
    return Promise.resolve(Response.json({ bars: {}, next_page_token: null }));
  } as unknown as typeof fetch;
  const data = new AlpacaBacktestData(
    new Map(),
    date,
    { key: "key", secret: "secret" },
    "https://paper-api.alpaca.markets",
    fetcher,
  );
  const chain = await data.chain("NVDA", "call", date, "2026-09-04");
  // Read as active and as inactive: the one contract comes back twice.
  assert.equal(chain[0]?.strike, 105);
  const day = await data.optionDay(["NVDA260904C00105000"], date);
  assert.deepEqual(day.get("NVDA260904C00105000"), []);
});

test("a 429 from Alpaca is waited out and asked again; a lasting one still fails", async () => {
  let calls = 0;
  let limited = 2;
  const fetcher = (() => {
    calls++;
    if (limited-- > 0)
      return Promise.resolve(
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "0.01" },
        }),
      );
    return Promise.resolve(
      Response.json({ option_contracts: [], next_page_token: null }),
    );
  }) as unknown as typeof fetch;
  const data = new AlpacaBacktestData(
    new Map(),
    date,
    { key: "key", secret: "secret" },
    "https://paper-api.alpaca.markets",
    fetcher,
  );
  // Two 429s, then the answer (active), then inactive at once.
  assert.deepEqual(await data.chain("NVDA", "call", date, "2026-09-04"), []);
  assert.equal(calls, 4);
  limited = 99;
  await assert.rejects(
    data.chain("NVDA", "put", date, "2026-09-04"),
    /failed \(429\)/,
  );
});

test("option bars are kept: a finished day's bars and volume are stored, read back without Alpaca, an empty day too", async () => {
  const store = new D1OptionBars(new SqliteD1(":memory:"));
  const liquid = "NVDA260904C00105000",
    thin = "NVDA260904C00110000";
  let calls = 0;
  const alpaca = (() => {
    calls++;
    return Promise.resolve(
      Response.json({
        bars: {
          [liquid]: [
            // 09:41 and 09:42 New York on the date (EDT, UTC-4)
            { t: `${date}T13:41:00Z`, o: 1, h: 1.2, l: 0.9, c: 1.1, v: 150 },
            { t: `${date}T13:42:00Z`, o: 1.1, h: 1.3, l: 1, c: 1.2, v: 90 },
          ],
        },
        next_page_token: null,
      }),
    );
  }) as unknown as typeof fetch;
  const make = (fetcher: typeof fetch) =>
    new AlpacaBacktestData(
      new Map(),
      date,
      { key: "k", secret: "s" },
      "https://paper-api.alpaca.markets",
      fetcher,
      undefined,
      store,
    );
  const first = await make(alpaca).optionDay([liquid, thin], date);
  assert.equal(calls, 1);
  assert.deepEqual(
    first.get(liquid)?.map((b) => [b.m, b.v]),
    [
      [11, 150],
      [12, 90],
    ],
  );
  // A second run reads the stored day: no Alpaca call, the same volume.
  const offline = (() =>
    Promise.reject(new Error("no network"))) as unknown as typeof fetch;
  const again = await make(offline).optionDay([liquid, thin], date);
  assert.deepEqual(again.get(liquid), first.get(liquid));
  assert.deepEqual(again.get(thin), []);
  // A session after the last finished one is never stored.
  const later = "2099-01-02";
  const live = new AlpacaBacktestData(
    new Map(),
    date,
    { key: "k", secret: "s" },
    "https://paper-api.alpaca.markets",
    alpaca,
    undefined,
    store,
  );
  await live.optionDay([liquid], later);
  assert.equal((await store.get([liquid], later)).size, 0);
});

test("the page splits a period into parts and reads typed tickers", () => {
  const days = sessionsBetween("2026-01-02", "2026-06-30");
  const parts = periodParts("2026-01-02", "2026-06-30", 60);
  assert.equal(parts[0]!.from, days[0]);
  assert.equal(parts.at(-1)!.to, days.at(-1));
  assert.equal(parts.length, Math.ceil(days.length / 60));
  assert.deepEqual(parseTickers("nvda, amd  TSLA;spy nvda 123"), [
    "NVDA",
    "AMD",
    "TSLA",
  ]);
  assert.deepEqual(periodRange(36, "2026-10-29"), {
    from: "2024-02-01",
    to: "2026-10-29",
  });
  assert.deepEqual(periodRange(1, "2026-10-29"), {
    from: "2026-09-30",
    to: "2026-10-29",
  });
});

test("the loader's clock moves through the period and never passes the parts in flight", () => {
  const days = sessionsBetween("2026-10-01", "2026-10-29");
  const busy = { done: 0, total: 10, startedAt: 0, lastDoneAt: 0 };
  // Before any part is back, a guessed pace; never past the 4 in flight.
  const early = runClock(busy, days, 3000, 4);
  assert.ok(early.fraction > 0 && early.fraction < 0.4, String(early.fraction));
  assert.equal(early.leftMs, null);
  const late = runClock(busy, days, 10 * 60_000, 4);
  assert.ok(late.fraction <= 0.4 * 0.95 + 1e-9);
  // 5 of 10 back after 20 s: a little past half way, about 18 s left.
  const half = runClock(
    { done: 5, total: 10, startedAt: 0, lastDoneAt: 20_000 },
    days,
    20_000,
    4,
  );
  assert.ok(half.fraction > 0.5 && half.fraction < 0.6, String(half.fraction));
  assert.ok(
    half.leftMs! > 15_000 && half.leftMs! < 20_000,
    String(half.leftMs),
  );
  // Two quick parts (cached bars) do not send the clock to the period's end.
  const quick = runClock(
    { done: 2, total: 6, startedAt: 0, lastDoneAt: 3000 },
    days,
    4000,
    4,
  );
  assert.ok(quick.fraction < 0.5, String(quick.fraction));
  assert.ok(quick.leftMs! > 5000, String(quick.leftMs));
  // A slower part than guessed does not move the clock back.
  const ahead = runClock(busy, days, 9000, 4);
  const slower = runClock(
    { done: 1, total: 10, startedAt: 0, lastDoneAt: 15_000 },
    days,
    15_000,
    4,
    ahead.fraction,
  );
  assert.ok(slower.fraction >= ahead.fraction);
  // The clock reads a session's minute: 21 sessions, at 0.5 the 11th at 12:45 New York.
  assert.equal(days.length, 21);
  const mid = runClock(
    { done: 5, total: 10, startedAt: 0, lastDoneAt: 0 },
    days,
    0,
    0,
  );
  assert.equal(new Date(mid.at).toISOString(), `${days[10]}T16:45:00.000Z`);
  assert.equal(clockText(65_000), "1:05");
});

test("Same as paper takes the live version, rules, size, limits and watched stocks", () => {
  const live = paperSetup(
    {
      ...defaultSettings,
      version: "2.7.0",
      sizePct: 3,
      maxBuysPerDay: 8,
      maxOpen: 5,
      stopPct: 25,
      off: ["QQQ"],
    },
    ["NVDA", "qqq", "TSLA", "NVDA"],
  );
  assert.equal(live.version, "2.7.0");
  assert.equal(live.rules.stopPct, 25);
  assert.deepEqual(live.money, { sizePct: 3, maxBuysPerDay: 8, maxOpen: 5 });
  assert.deepEqual(live.tickers, ["NVDA", "TSLA"]);
});

// A stand-in for the server's /api/backtest-jobs (the real handler and store
// on an in-memory database); the test decides when each part finishes.
function fakeJobServer() {
  const jobs = new BacktestJobs(new SqliteD1(":memory:"));
  const tasks: PartTask[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const u = new URL(url, "https://app.test");
    const result = await handleBacktestJobs({
      method: init?.method ?? "GET",
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      owner: "",
      jobs,
      start: async (t) => void tasks.push(...t),
    });
    return Response.json(result.body, { status: result.status });
  }) as typeof fetch;
  // Synthetic part results: no trades, a failure for MU.
  const finish = (index: number) =>
    runPart(jobs, tasks[index]!, async (_bot, request) =>
      request.symbol === "MU"
        ? { status: 502, body: { error: "Alpaca said no" } }
        : {
            status: 200,
            body: {
              symbol: request.symbol,
              sessions: 1,
              noData: 0,
              trades: [],
              skips: [],
            },
          },
    );
  return { fetcher, tasks, finish };
}

const sixStocks = {
  version: "2.7",
  rules: {} as never,
  fillPct: 2,
  tickers: ["NVDA", "AMD", "TSLA", "MU", "META", "AAPL"],
  from: "2026-10-01",
  to: "2026-10-29",
};

test("a run is handed to the server; its progress and parts are read while it runs", async () => {
  const realFetch = globalThis.fetch;
  const server = fakeJobServer();
  globalThis.fetch = server.fetcher;
  try {
    await startRun(sixStocks);
    assert.equal(server.tasks.length, 6, "the whole run is sent at once");
    assert.deepEqual(
      { done: runState().busy?.done, total: runState().busy?.total },
      { done: 0, total: 6 },
    );
    await server.finish(0);
    await server.finish(3); // MU fails
    await mainRun.resume(); // the page shows again: read now
    assert.equal(runState().busy?.done, 2);
    assert.equal(runState().runs.length, 1);
    assert.deepEqual(runState().errors, [
      "MU 2026-10-01 → 2026-10-29: Alpaca said no",
    ]);
    for (const i of [1, 2, 4, 5]) await server.finish(i);
    await mainRun.resume();
    assert.equal(runState().busy, null, "done");
    assert.deepEqual(
      runState().runs.map((r) => r.symbol),
      ["NVDA", "AMD", "TSLA", "META", "AAPL"],
      "in part order, each once",
    );
    assert.deepEqual(runState().ran, sixStocks);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Stop ends the run at once and on the server: the parts back stay, no new part starts", async () => {
  const realFetch = globalThis.fetch;
  const server = fakeJobServer();
  globalThis.fetch = server.fetcher;
  try {
    await startRun(sixStocks);
    await server.finish(0);
    await mainRun.resume();
    stopRun();
    // At once: not busy, the stop and the part already back are kept.
    assert.equal(runState().busy, null);
    assert.deepEqual(runState().stopped, { done: 1, total: 6 });
    assert.equal(runState().runs.length, 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await server.finish(1), "skipped", "no new part starts");
    assert.deepEqual(runState().stopped, { done: 1, total: 6 });
    assert.equal(runState().runs.length, 1);
    assert.equal(runState().errors.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a past run opens with its own result; a new run cannot start while one runs", async () => {
  const realFetch = globalThis.fetch;
  const server = fakeJobServer();
  globalThis.fetch = server.fetcher;
  try {
    await startRun({ ...sixStocks, tickers: ["NVDA"] });
    await server.finish(0);
    await mainRun.resume();
    const first = runState().id!;
    assert.equal(runState().busy, null);
    await startRun({ ...sixStocks, tickers: ["AMD", "TSLA"] });
    const second = runState().id!;
    assert.notEqual(first, second);
    // While the second runs, another run is not opened.
    await mainRun.open(first);
    assert.equal(runState().id, second);
    await server.finish(1);
    await server.finish(2);
    await mainRun.resume();
    assert.equal(runState().busy, null);
    await mainRun.open(first);
    assert.equal(runState().id, first);
    assert.deepEqual(
      runState().runs.map((r) => r.symbol),
      ["NVDA"],
    );
    assert.deepEqual(runState().ran?.tickers, ["NVDA"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("History reads a past run while another runs: the run going on keeps its progress", async () => {
  const realFetch = globalThis.fetch;
  const server = fakeJobServer();
  globalThis.fetch = server.fetcher;
  try {
    await startRun({ ...sixStocks, tickers: ["NVDA"] });
    await server.finish(server.tasks.length - 1);
    await mainRun.resume();
    const first = runState().id!;
    await startRun({ ...sixStocks, tickers: ["AMD", "TSLA"] });
    const second = runState().id!;
    await mainRun.view(first);
    const past = mainRun.viewed();
    assert.equal(past.id, first);
    assert.equal(past.status, "done");
    assert.deepEqual(
      past.run.runs.map((r) => r.symbol),
      ["NVDA"],
    );
    assert.deepEqual(past.run.ran?.tickers, ["NVDA"]);
    // The run going on is untouched: still shown, still running.
    assert.equal(runState().id, second);
    assert.notEqual(runState().busy, null);
    await mainRun.view("gone");
    assert.match(mainRun.viewed().error ?? "", /no longer kept/);
    for (const i of [1, 2]) await server.finish(server.tasks.length - i);
    await mainRun.resume();
    assert.equal(runState().busy, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a run says what it tested: its changed rules in words and its stocks", () => {
  const v = versionById(currentVersion)!;
  assert.deepEqual(
    mainRuleChanges({ ...sixStocks, version: v.id, rules: v.rules }),
    [],
  );
  const changed = mainRuleChanges({
    ...sixStocks,
    version: `${v.id}*`,
    rules: {
      ...v.rules,
      stopPct: v.rules.stopPct + 5,
      skipEarnings: !v.rules.skipEarnings,
      nightCapPct: 40,
      sizeSteps: [{ from: 10, pct: 5 }],
    },
  });
  const on = (b: boolean) => (b ? "on" : "off");
  assert.deepEqual(
    changed.map(changeText).sort(),
    [
      `Skip earnings reaction days ${on(v.rules.skipEarnings)} → ${on(!v.rules.skipEarnings)}`,
      `Stop ${v.rules.stopPct}% → ${v.rules.stopPct + 5}%`,
      `Night cap ${v.rules.nightCapPct}% → 40%`,
      "Size steps changed",
    ].sort(),
  );
  assert.equal(changed.length, 4);
  const lists = [{ label: "Semis", tickers: ["MU", "AMD", "NVDA"] }];
  assert.equal(stocksLabel(["NVDA", "MU", "AMD"], lists), "Semis · 3 stocks");
  assert.equal(stocksLabel(["TSLA", "MU"], lists), "TSLA, MU");
  assert.equal(
    stocksLabel(["A", "B", "C", "D", "E", "F"], lists),
    "6 stocks: A, B, C, D +2",
  );
});

test("a History row names its period by length", () => {
  assert.equal(periodName("2025-11-05", "2026-11-04"), "1 year");
  assert.equal(periodName("2026-05-05", "2026-11-04"), "6 months");
  assert.equal(periodName("2026-08-05", "2026-11-04"), "3 months");
  assert.equal(periodName("2026-10-05", "2026-11-04"), "1 month");
  assert.equal(periodName("2026-10-12", "2026-10-30"), "3 weeks");
  assert.equal(periodName("2026-10-29", "2026-10-30"), "2 days");
  assert.equal(periodDates("2025-11-05", "2026-11-04"), "5 Nov 25 → 4 Nov 26");
});

test("a run's result in short: the default money, and its share on real quotes", () => {
  const v = versionById(currentVersion)!;
  const ran = { ...sixStocks, version: v.id, rules: v.rules };
  const trade = (priced: "quotes" | "trades", sell: number) => ({
    id: `NVDA|2026-10-01|${priced}`,
    symbol: "NVDA",
    contract: "NVDA261002C00200000",
    date: "2026-10-01",
    minute: 30,
    sizeShare: 1,
    open: false,
    priced,
    steps: [
      {
        date: "2026-10-01",
        minute: 30,
        kind: "buy",
        share: 1,
        price: 1,
        reason: "entry",
      },
      {
        date: "2026-10-01",
        minute: 60,
        kind: "sell",
        share: 1,
        price: sell,
        reason: "stage-full",
      },
    ],
  });
  const summary = mainRunSummary(ran, [
    { trades: [trade("quotes", 2), trade("trades", 0.5)] } as never,
  ]);
  assert.equal(summary.v, 1);
  assert.equal(summary.trades, 2);
  assert.equal(summary.winRate, 50);
  assert.equal(summary.realQuotesPct, 50);
  assert.ok(summary.pnl > 0, "the double beats the half");
  assert.ok(isCurrentSummary(summary));
  assert.ok(!isCurrentSummary({ returnPct: 1 }), "an older summary is redone");
});

test("held: the nights a position was held after its entry day", () => {
  const step = (date: string, kind: "buy" | "sell" | "carry") => ({
    date,
    minute: 10,
    kind,
    share: 1,
    price: 1,
    reason: "entry" as const,
  });
  assert.equal(
    nightsHeld([step("2026-10-01", "buy"), step("2026-10-01", "sell")]),
    0,
  );
  assert.equal(
    nightsHeld([
      step("2026-10-01", "buy"),
      step("2026-10-01", "carry"),
      step("2026-10-02", "sell"),
    ]),
    1,
  );
  assert.equal(nightsHeld([]), null);
});

test("a skipped signal opens like a trade: why it was skipped, what the bot saw, the what-if's fills", async () => {
  const { data } = fakeData(5000);
  const run = await runStock(
    "NVDA",
    [date],
    { ...defaultSettings, pyramid: false },
    data,
    backtestCalendar,
  );
  const row = signalRows([run], []).find((r) => !r.bought)!;
  assert.equal(row.skip?.reason, "premarket");
  const s = skipStory(row, defaultSettings, "2.10.0")!;
  const w = row.skip!.whatIf!;
  assert.equal(s.closed.symbol, w.contract);
  assert.equal(s.closed.entry, w.steps[0]!.price);
  assert.equal(s.closed.fills?.[0]?.side, "buy");
  assert.ok(Math.abs((s.closed.pnlPct ?? 0) - w.ret * 100) < 1e-9);
  assert.equal(s.story.entryTitle, "Why the bot did not buy");
  assert.match(s.story.entry[0]!, /^Not bought: /);
  assert.ok(s.story.entry.some((x) => /a model, not a trade/.test(x)));
  assert.ok(s.story.markers.some((m) => m.kind === "signal"));
  // A bought row has no skip story; a skip without a what-if neither.
  const bought = { ...row, skip: null };
  assert.equal(skipStory(bought, defaultSettings, "2.10.0"), null);
  const bare = { ...row, skip: { ...row.skip!, whatIf: undefined } };
  assert.equal(skipStory(bare, defaultSettings, "2.10.0"), null);
});

test("signals sort by any column, the ones without a value last; trades by money, return or time", () => {
  const base = signalRows([], [])[0];
  assert.equal(base, undefined);
  const row = (
    key: string,
    minute: number,
    ret: number | null,
    symbol: string,
  ) =>
    ({
      key,
      symbol,
      date: "2026-10-01",
      minute,
      right: "C",
      t: null,
      rvol: null,
      d2: null,
      bonus: false,
      pyramid: false,
      stock: null,
      bought: false,
      outcome: "x",
      reason: "premarket",
      detail: "",
      contract: null,
      strike: null,
      expiry: null,
      price: null,
      boughtAt: null,
      bid: null,
      ask: null,
      delta: null,
      volume30: null,
      ret,
      nights: null,
      model: true,
      modelled: false,
      iv: null,
      ivFrom: null,
      trade: null,
      skip: null,
    }) as Parameters<typeof sortSignals>[0][number];
  const rows = [
    row("a", 10, 0.5, "MSFT"),
    row("b", 20, null, "AAPL"),
    row("c", 30, -0.2, "NVDA"),
  ];
  assert.deepEqual(
    sortSignals(rows, "ret", "desc").map((r) => r.key),
    ["a", "c", "b"],
  );
  assert.deepEqual(
    sortSignals(rows, "ret", "asc").map((r) => r.key),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    sortSignals(rows, "when", "desc").map((r) => r.key),
    ["c", "b", "a"],
  );
  assert.deepEqual(
    sortSignals(rows, "symbol", "asc").map((r) => r.key),
    ["b", "a", "c"],
  );
  const trade = (id: string, minute: number, pnl: number, status: string) =>
    ({
      trade: { id, date: "2026-10-01", minute, symbol: id },
      status,
      pnl,
      retPct: pnl / 10,
    }) as unknown as Parameters<typeof sortTrades>[0][number];
  const trades = [
    trade("A", 10, 500, "taken"),
    trade("B", 20, 0, "day-limit"),
    trade("C", 30, -300, "taken"),
  ];
  assert.deepEqual(
    sortTrades(trades, "pnl-desc").map((a) => a.trade.id),
    ["A", "C", "B"],
  );
  assert.deepEqual(
    sortTrades(trades, "pnl-asc").map((a) => a.trade.id),
    ["C", "A", "B"],
  );
  assert.deepEqual(
    sortTrades(trades, "newest").map((a) => a.trade.id),
    ["C", "B", "A"],
  );
  assert.deepEqual(
    sortTrades(trades, "oldest").map((a) => a.trade.id),
    ["A", "B", "C"],
  );
});
