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
import { defaultExitRules } from "../packages/trading/src/bot/exits.js";
import type { MinuteBar } from "../packages/trading/src/bot/signal.js";
import {
  clockText,
  nightsHeld,
  paperSetup,
  parseTickers,
  periodParts,
  runClock,
  periodRange,
  sessionsBetween,
} from "../apps/web/src/bot-backtest-model.js";
import {
  runState,
  startRun,
  stopRun,
} from "../apps/web/src/bot-backtest-run.js";

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
});

test("with only the bots' saved books (a few minutes): the trade is marked on the last one and sold at a fresh bid", async () => {
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
  // The 15:50 sale waits for the next fresh book (15:45 is too old by then)
  // and gets the bid of the day's last one.
  const last = t.steps.at(-1)!;
  assert.equal(last.minute, 375);
  assert.ok(Math.abs(last.price - (p - 0.05)) < 1e-9, String(last.price));
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

test("Stop ends the run at once: the requests in flight are cancelled, the parts back stay, no new part starts", async () => {
  const realFetch = globalThis.fetch;
  const signals: AbortSignal[] = [];
  let calls = 0;
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    calls++;
    const signal = init.signal!;
    signals.push(signal);
    // The first part comes back; the others hang until cancelled.
    if (calls === 1)
      return Promise.resolve(
        Response.json({
          symbol: "NVDA",
          sessions: 1,
          noData: 0,
          trades: [],
          skips: [],
        }),
      );
    return new Promise((_, reject) =>
      signal.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      ),
    );
  }) as typeof fetch;
  try {
    const ran = {
      version: "2.7",
      rules: {} as never,
      fillPct: 2,
      tickers: ["NVDA", "AMD", "TSLA", "MU", "META", "AAPL"],
      from: "2026-10-01",
      to: "2026-10-29",
    };
    const running = startRun(ran);
    await new Promise((r) => setTimeout(r, 20));
    const before = calls;
    stopRun();
    // At once: not busy, the stop and the part already back are kept.
    assert.equal(runState().busy, null);
    assert.deepEqual(runState().stopped, { done: 1, total: 6 });
    assert.equal(runState().runs.length, 1);
    await running;
    assert.equal(
      runState().errors.length,
      0,
      "cancelled parts are not failures",
    );
    assert.ok(
      signals.slice(1).every((x) => x.aborted),
      "the hanging requests are cancelled",
    );
    assert.equal(calls, before, "no new part starts after Stop");
  } finally {
    globalThis.fetch = realFetch;
  }
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
