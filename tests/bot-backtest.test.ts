// SYNTHETIC market data, chains and fills: the Main bot's backtest on the
// Backtest page (packages/trading/src/bot/backtest.ts, backtest-account.ts).
// On real bars the trades were checked by hand against the Python replay
// (week.py, research/indi-v2) with scripts/bot-backtest-run.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AlpacaBacktestData,
  backtestCalendar,
} from "../packages/market-data/src/bot-backtest.js";
import { previousSessions } from "../packages/market-data/src/calendar.js";
import {
  impliedDelta,
  runStock,
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
import type { MinuteBar } from "../packages/trading/src/bot/signal.js";
import {
  parseTickers,
  periodParts,
  periodRange,
  sessionsBetween,
} from "../apps/web/src/bot-backtest-model.js";

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
