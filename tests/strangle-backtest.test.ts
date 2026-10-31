// SYNTHETIC bars, chains, books and seconds: the Volume bot's backtest
// (packages/trading/src/strangle/backtest.ts). Its parity with the research
// simulator on real data is checked by scripts/volume-backtest-check.ts
// (local data only).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backtestCalendar,
  handleBotBacktest,
} from "../packages/market-data/src/bot-backtest.js";
import { previousSessions } from "../packages/market-data/src/calendar.js";
import {
  handleVolumeBacktest,
  secondsFromTrades,
} from "../packages/market-data/src/volume-backtest.js";
import {
  bsPrice,
  occSymbol,
  yearsToExpiry,
  type ChainContract,
  type QuoteMinute,
} from "../packages/trading/src/bot/backtest.js";
import type { MinuteBar } from "../packages/trading/src/bot/signal.js";
import {
  runVolumeStock,
  tradeReturn,
  volumeAccount,
  type SecondBook,
  type ShockAlert,
  type VolumeBacktestData,
  type VolumeSignal,
  type VolumeTrade,
} from "../packages/trading/src/strangle/backtest.js";
import {
  defaultStrangleSettings,
  type StrangleSettings,
} from "../packages/trading/src/strangle/settings.js";

const DAY = "2026-10-22"; // a Thursday: a 0DTE expiry here
const SYMBOL = "NVDA";

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
// A burst at 10:08-10:09 New York (minutes 38-39), a climb to 10:29, then a fall.
const climbThenFall = () =>
  session(
    100,
    (m) => {
      if (m === 38 || m === 39) return 0.003;
      if (m >= 40 && m < 60) return 0.001;
      if (m >= 60) return -0.001;
      return wiggle(m);
    },
    (m) => (m === 38 || m === 39 ? 20000 : 1000),
  );

const settings: StrangleSettings = {
  ...defaultStrangleSettings,
  delta: 0.2,
  minVolume: 0,
  shockAlert: true,
  fastAlert: false,
};

/** Calls of DAY's expiry around the stock, priced at a 60% volatility on minute 39. */
function harness(o: {
  today?: MinuteBar[];
  seconds?: [number, number][];
  books?: (contract: string) => QuoteMinute[];
  optionSeconds?: SecondBook[];
  shocks?: ShockAlert[];
  premarket?: number;
  expiries?: string[];
}) {
  const today = o.today ?? climbThenFall();
  const prior = previousSessions(DAY, 25);
  const spot = today[39]!.c * 1.002;
  const chain: ChainContract[] = [];
  const optionBars = new Map<string, MinuteBar[]>();
  for (const expiry of o.expiries ?? [DAY])
    for (let k = 98; k <= 108; k++)
      for (const right of ["C", "P"] as const) {
        const symbol = occSymbol(SYMBOL, expiry, right, k);
        chain.push({ symbol, expiry, strike: k });
        const price = bsPrice(
          spot,
          k,
          yearsToExpiry(DAY, 39, expiry),
          0.6,
          right === "C",
        )[0];
        // A print every minute around the alert (the pick reads the last one by its minute).
        optionBars.set(
          symbol,
          [36, 37, 38, 39].map((m) => ({
            m,
            o: price,
            h: price,
            l: price,
            c: price,
            v: 50,
          })),
        );
      }
  const data: VolumeBacktestData = {
    lastSession: DAY,
    bars: (s, d) => {
      if (s !== SYMBOL) return [];
      if (d === DAY) return today;
      return prior.includes(d) ? quietDay() : [];
    },
    premarket: (_s, d) => (d === DAY ? (o.premarket ?? 1000) : 1000),
    earnings: async () => [],
    async chain(_s, right, from, to) {
      const r = right === "call" ? "C" : "P";
      return chain.filter(
        (c) => c.symbol.includes(`${r}0`) && c.expiry >= from && c.expiry <= to,
      );
    },
    async optionDay(contracts) {
      return new Map(contracts.map((c) => [c, optionBars.get(c) ?? []]));
    },
    async optionQuotes(contract, from) {
      return new Map([[from, o.books?.(contract) ?? []]]);
    },
    async stockSeconds(_s, _d, from, to) {
      return (o.seconds ?? []).filter(([s]) => s >= from && s <= to);
    },
    async shockAlerts() {
      return o.shocks ?? [];
    },
  };
  if (o.optionSeconds) data.optionSeconds = async () => o.optionSeconds!;
  return { data, today, spot };
}

const run = (data: VolumeBacktestData, s: StrangleSettings = settings) =>
  runVolumeStock(SYMBOL, [DAY], s, data, backtestCalendar, { fillPct: 2 });

const books = (): QuoteMinute[] => [
  { m: 39, bid: 1.0, ask: 1.2 },
  { m: 40, bid: 1.05, ask: 1.25 },
  { m: 71, bid: 0.8, ask: 0.9 },
];

test("volume backtest: the plan's alert, the side within 15 s, the 0.20 leg bought at the book and sold on the give-back at the bid", async () => {
  const today = climbThenFall();
  const stock0 = today[39]!.c;
  const { data } = harness({
    today,
    // the side 4 s after the alert (the end of minute 39 = second 2400)
    seconds: [
      [2401, stock0 * 1.0001],
      [2404, stock0 * 1.001],
    ],
    books,
  });
  const r = await run(data);
  const plan = r.signals.filter((s) => s.kind === "plan");
  assert.equal(plan.length, 1);
  const sig = plan[0]!;
  assert.equal(sig.minute, 39);
  assert.equal(sig.second, 2400);
  assert.equal(sig.outcome, "traded", sig.detail);
  assert.ok(sig.burst! > 1.1);
  const t = sig.trade!;
  assert.equal(t.right, "C");
  assert.equal(t.toSide, 4);
  assert.equal(t.expiry, DAY);
  assert.ok(Math.abs(t.delta - 0.2) < 0.1, `delta ${t.delta}`);
  // The last minute closed at the buy (39): the mid + a quarter of the spread.
  assert.equal(t.buyPriced, "minutes");
  assert.ok(Math.abs(t.buy - 1.15) < 1e-9);
  assert.ok(Math.abs(t.spread! - 0.2 / 1.1) < 1e-9);
  // No sale in the first 30 minutes after the buy minute (40); the fall from
  // 10:30 gives back 0.75 of the move by minute 71, sold at its bid.
  assert.equal(t.buyMinute, 40);
  assert.equal(t.exitReason, "giveback");
  assert.equal(t.exitMinute, 71);
  assert.equal(t.sell, 0.8);
  assert.equal(t.sellPriced, "minutes");
  assert.ok(
    Math.abs(tradeReturn(t, 0.62) - (80 - 0.62) / (115 + 0.62) + 1) < 1e-9,
  );
});

test("volume backtest: no side within 15 s ends the watch; a side against the burst is skipped", async () => {
  const today = climbThenFall();
  const stock0 = today[39]!.c;
  const late = await run(
    harness({ today, seconds: [[2420, stock0 * 1.001]], books }).data,
  );
  assert.equal(
    late.signals.find((s) => s.kind === "plan")!.outcome,
    "slow_cross",
  );
  // Without the cross filter the wait is the 10 minutes: the same side trades.
  const wait = await run(
    harness({ today, seconds: [[2420, stock0 * 1.001]], books }).data,
    { ...settings, crossFilter: false },
  );
  assert.equal(wait.signals.find((s) => s.kind === "plan")!.outcome, "traded");
  const against = await run(
    harness({ today, seconds: [[2403, stock0 * 0.999]], books }).data,
  );
  assert.equal(
    against.signals.find((s) => s.kind === "plan")!.outcome,
    "burst",
  );
});

test("volume backtest: the shock holds 5 checks in a row, buys at the 1-second book and chases the ask; over a 30% spread no buy", async () => {
  const today = climbThenFall();
  const price = today[39]!.c;
  const up = price * 1.002;
  // A dip back resets the count: the 5th check in a row is second 2397.
  const seconds: [number, number][] = [
    [2385, up],
    [2386, up],
    [2387, price],
    [2390, up],
    [2391, up],
    [2393, up],
    [2395, up],
    [2397, up],
  ];
  const shocks = [{ date: DAY, second: 2380, price, up: true }];
  const optionSeconds: SecondBook[] = [
    { s: 2398, bid: 1.0, ask: 1.2 },
    { s: 2409, bid: 1.3, ask: 1.4 }, // the bid 10 s after the buy is above its price
  ];
  const { data } = harness({ today, seconds, shocks, optionSeconds, books });
  const r = await run(data);
  const sig = r.signals.find((s) => s.kind === "shock")!;
  assert.equal(sig.outcome, "traded", sig.detail);
  assert.equal(sig.minute, 39);
  assert.equal(sig.trade!.sideSecond, 2397);
  assert.equal(sig.trade!.buyPriced, "seconds");
  assert.equal(sig.trade!.buy, 1.4);
  // The same alert with a 40% spread at the buy.
  const wide = harness({
    today,
    seconds,
    shocks,
    optionSeconds: [{ s: 2398, bid: 1.0, ask: 1.5 }],
    books,
  });
  const w = await run(wide.data);
  assert.equal(
    w.signals.find((s) => s.kind === "shock")!.outcome,
    "wide_spread",
  );
  // Shock alerts off: only the plan's alert.
  const off = await run(data, { ...settings, shockAlert: false });
  assert.equal(off.signals.filter((s) => s.kind === "shock").length, 0);
});

test("volume backtest: the news filter, no expiry, and no book in strict mode", async () => {
  const today = climbThenFall();
  const stock0 = today[39]!.c;
  const seconds: [number, number][] = [[2404, stock0 * 1.001]];
  const busy = await run(
    harness({ today, seconds, books, premarket: 5000 }).data,
  );
  assert.equal(busy.signals[0]!.outcome, "premarket");
  const none = await run(
    harness({ today, seconds, books, expiries: ["2026-11-20"] }).data,
  );
  assert.equal(none.signals[0]!.outcome, "no_expiry");
  // Without books the option's bars price the trade, unless strict.
  const { data } = harness({ today, seconds });
  const bars = await run(data);
  assert.equal(bars.signals[0]!.outcome, "no_fill"); // no bar after the side either
  const strict = await runVolumeStock(
    SYMBOL,
    [DAY],
    settings,
    data,
    backtestCalendar,
    {
      fillPct: 2,
      strictQuotes: true,
    },
  );
  assert.equal(strict.signals[0]!.outcome, "no_fill");
  assert.equal(strict.signals[0]!.detail, "no book at the buy");
});

function signal(
  date: string,
  symbol: string,
  second: number,
  t: Partial<VolumeTrade>,
): VolumeSignal {
  return {
    id: `${symbol}|${date}|plan|${second}`,
    symbol,
    date,
    kind: "plan",
    minute: Math.floor(second / 60) - 1,
    second,
    alert: "up",
    price: 100,
    unit: 0.002,
    burst: 2,
    expiry: date,
    outcome: "traded",
    detail: "",
    trade: {
      contract: "X",
      right: "C",
      strike: 101,
      expiry: date,
      delta: 0.2,
      fallback: "",
      sideSecond: second + 2,
      toSide: 2,
      stockIn: 100,
      buyMinute: Math.floor(second / 60),
      buy: 1,
      book: null,
      spread: null,
      buyPriced: "minutes",
      exitMinute: Math.floor(second / 60) + 30,
      exitReason: "giveback",
      sell: 2,
      sellPriced: "minutes",
      stockOut: 101,
      ...t,
    },
  };
}

test("volume account: one trade at a time a stock, 2 a day, sized from the morning, fees both ways, the live limits", () => {
  const D1 = "2026-10-21";
  const runs = [
    {
      symbol: "A",
      ignored: [],
      signals: [
        signal(D1, "A", 600, {
          buyMinute: 10,
          exitMinute: 50,
          buy: 1,
          sell: 2,
        }),
        // bought while the first is open: busy
        signal(D1, "A", 1800, {
          buyMinute: 30,
          exitMinute: 60,
          buy: 1,
          sell: 3,
        }),
        signal(D1, "A", 3600, {
          buyMinute: 60,
          exitMinute: 90,
          buy: 2,
          sell: 1,
        }),
        // a third trade of the stock that day
        signal(D1, "A", 6000, {
          buyMinute: 100,
          exitMinute: 120,
          buy: 1,
          sell: 1,
        }),
      ],
    },
    {
      symbol: "B",
      ignored: [],
      signals: [
        signal(D1, "B", 1200, {
          buyMinute: 20,
          exitMinute: 40,
          buy: 0.5,
          sell: 0.25,
        }),
        signal(DAY, "B", 1200, {
          buyMinute: 20,
          exitMinute: 40,
          buy: 1,
          sell: 0,
        }),
      ],
    },
  ];
  const money = {
    start: 100_000,
    sizePct: 2,
    feePerContract: 0.62,
    maxPerStock: 2,
    limits: false,
    maxTradesPerDay: 15,
    maxOpen: 5,
    dayLossPct: 7.5,
  };
  const a = volumeAccount(runs, money);
  const status = (id: string) =>
    a.trades.find((x) => x.signal.id === id)!.status;
  assert.equal(status(`A|${D1}|plan|1800`), "busy");
  assert.equal(status(`A|${D1}|plan|6000`), "per_stock");
  assert.equal(a.taken, 4);
  // Day 1: $2,000 a trade from $100,000: A 20 at $1 -> $2, A 10 at $2 -> $1, B 40 at $0.50 -> $0.25.
  const fee = 0.62 * 2;
  const day1 =
    20 * 100 - 20 * fee + (-10 * 100 - 10 * fee) + (-40 * 25 - 40 * fee);
  // Day 2 sizes from the new morning: B 20 at $1 -> 0 (the whole cost).
  const start2 = 100_000 + day1;
  const q2 = Math.floor((0.02 * start2) / 100);
  const day2 = -q2 * 100 - q2 * fee;
  assert.ok(Math.abs(a.end - (start2 + day2)) < 1e-6);
  assert.equal(a.won, 1);
  // The drop on closed trades in sale order: day 1's B sale (minute 40) comes first.
  assert.ok(a.maxDrawdownPct > 0);
  // The live limits: one trade open at a time refuses B while A's first is open.
  const limited = volumeAccount(runs, { ...money, limits: true, maxOpen: 1 });
  assert.equal(
    limited.trades.find((x) => x.signal.id === `B|${D1}|plan|1200`)!.status,
    "max_open",
  );
  // Too small: a $2,000 trade cannot buy one $25 contract.
  const tiny = volumeAccount(
    [
      {
        symbol: "C",
        ignored: [],
        signals: [signal(D1, "C", 600, { buy: 25, sell: 30 })],
      },
    ],
    money,
  );
  assert.equal(tiny.trades[0]!.status, "too_small");
});

test("volume backtest data: the last trade each second by Alpaca's bar rules", () => {
  const openMs = Date.parse("2026-10-22T13:30:00Z");
  const at = (s: number, ms = 0) =>
    new Date(openMs + s * 1000 + ms).toISOString();
  const rows = secondsFromTrades(
    [
      { t: at(2400, 100), x: "Q", p: 100, s: 100, c: ["@"] },
      { t: at(2400, 900), x: "Q", p: 100.5, s: 100, c: ["@"] },
      { t: at(2402, 10), x: "Q", p: 101, s: 100, c: ["@"] },
      // an odd lot sets no price
      { t: at(2403, 10), x: "Q", p: 150, s: 10, c: ["@", "I"] },
      // outside the window
      { t: at(2420), x: "Q", p: 90, s: 100, c: ["@"] },
    ],
    openMs,
    2400,
    2410,
  );
  assert.deepEqual(rows, [
    [2400, 100.5],
    [2402, 101],
  ]);
});

test("backtest handlers: a range in early 2024 is read back from its end, not 400 sessions back (the calendar starts in 2024)", async () => {
  const down = (async () =>
    new Response("", { status: 500 })) as unknown as typeof fetch;
  const credentials = { key: "k", secret: "s" };
  const now = Date.parse("2026-10-31T12:00:00Z");
  const body = { symbol: "NVDA", from: "2024-02-01", to: "2024-02-29" };
  // Past the dates: the market data fails here (502), not the calendar.
  const v = await handleVolumeBacktest(
    body,
    credentials,
    "https://paper",
    down,
    now,
  );
  assert.equal(v.status, 502);
  const b = await handleBotBacktest(
    body,
    credentials,
    "https://paper",
    down,
    now,
  );
  assert.equal(b.status, 502);
  const long = await handleVolumeBacktest(
    { ...body, to: "2024-06-28" },
    credentials,
    "https://paper",
    down,
    now,
  );
  assert.deepEqual(long, {
    status: 400,
    body: { error: "At most 60 sessions a request" },
  });
});
