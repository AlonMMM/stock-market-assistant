import assert from "node:assert/strict";
import test from "node:test";
import { botHistory, botPortfolio } from "../apps/trader/src/bot-portfolio.js";
import type { BotPosition } from "../apps/trader/src/bot-store.js";
import type { Broker } from "../packages/trading/src/broker.js";

// The Bot trades tab for an account read through the trading service (IBKR):
// synthetic account, positions, orders and quotes; no broker is contacted.

const nvda = "NVDA261023C00110000";
const other = "AAPL261023P00200000"; // the owner's own IBKR trade, not the bot's
const noon = Date.parse("2026-10-05T16:00:00Z");

function position(over: Partial<BotPosition>): BotPosition {
  return {
    id: "p1",
    day: "2026-10-02",
    symbol: "NVDA",
    contract: nvda,
    right: "C",
    qty: 3,
    bought: 3,
    cost: 1.0,
    entryMinute: 30,
    entryStock: 100,
    nights: 0,
    checksDone: [],
    morningDone: false,
    decidedOn: null,
    broker: "ibkr",
    status: "open",
    jobId: null,
    dry: false,
    sales: [],
    openedAt: Date.parse("2026-10-02T14:00:00Z"),
    closedAt: null,
    ...over,
  };
}

const fake = {
  name: "fake",
  capabilities: {
    paper: true,
    closeOnlyOrders: false,
    optionStops: true,
    replaceInPlace: true,
    ownEquityHistory: false,
  },
  account: async () => ({
    equity: 50_000,
    lastEquity: 49_000,
    buyingPower: 20_000,
  }),
  marketOpen: async () => true,
  positions: async () => [
    { symbol: nvda, qty: 3, avgEntryPrice: 1.0 },
    { symbol: other, qty: 2, avgEntryPrice: 2.0 },
  ],
  openOrders: async () => [
    {
      id: "7",
      symbol: nvda,
      side: "sell",
      status: "Submitted",
      qty: 3,
      filledQty: 0,
      filledAvgPrice: null,
      limitPrice: null,
      stopPrice: 0.5,
      type: "stop",
    },
    {
      id: "8",
      symbol: other,
      side: "sell",
      status: "Submitted",
      qty: 2,
      filledQty: 0,
      filledAvgPrice: null,
      limitPrice: 3,
      stopPrice: null,
      type: "limit",
    },
  ],
  quote: async (symbol: string) => ({
    symbol,
    underlying: "NVDA",
    expiry: "2026-10-23",
    right: "call" as const,
    strike: 110,
    bid: 1.4,
    ask: 1.6,
    delta: 0.2,
  }),
} as unknown as Broker;

test("bot portfolio: the bot's contracts only, marked at the mid, with their stops; the whole account's totals", async () => {
  const view = await botPortfolio(fake, [position({})], noon);
  assert.equal(view.paper, true);
  assert.equal(view.marketClosed, false);
  assert.deepEqual(view.account, {
    equity: 50_000,
    cash: 20_000,
    buyingPower: 20_000,
    dayChange: 1000,
    dayChangePct: (1000 / 49_000) * 100,
  });
  assert.equal(view.positions.length, 1);
  const p = view.positions[0]!;
  assert.deepEqual(
    [p.symbol, p.underlying, p.qty, p.entry, p.price, p.value, p.cost, p.pnl],
    [nvda, "NVDA", 3, 1.0, 1.5, 450, 300, 150],
  );
  assert.equal(p.pnlPct, 50);
  assert.equal(p.delta, 0.2);
  assert.deepEqual(p.stop, { price: 0.5, qty: 3, lossPct: 50, risk: 150 });
  assert.equal(view.riskAtStops, 150);
  assert.equal(view.unprotected, 0);
  // The owner's own order on another contract is not the bot's.
  assert.deepEqual(
    view.orders.map((o) => [o.id, o.type, o.stopPrice]),
    [["7", "stop", 0.5]],
  );
  assert.deepEqual(view.shortRisks, []);
  // Nothing of the bot's at this account: an empty, valid view.
  const empty = await botPortfolio(fake, [], noon);
  assert.deepEqual(
    [empty.positions, empty.orders, empty.riskAtStops],
    [[], [], 0],
  );
});

test("bot portfolio: a position without a quote has no price and says so; a partial stop is unprotected", async () => {
  const quiet = {
    ...fake,
    quote: async () => {
      throw new Error("no data");
    },
    openOrders: async () => [
      {
        id: "7",
        symbol: nvda,
        side: "sell",
        status: "Submitted",
        qty: 1,
        filledQty: 0,
        filledAvgPrice: null,
        limitPrice: null,
        stopPrice: 0.5,
      },
    ],
  } as unknown as Broker;
  const view = await botPortfolio(quiet, [position({})], noon);
  const p = view.positions[0]!;
  assert.deepEqual(
    [p.price, p.value, p.pnl, p.pnlPct],
    [null, null, null, null],
  );
  assert.match(p.marketDataIssue ?? "", /No quote/);
  assert.equal(p.stop?.qty, 1);
  assert.equal(view.unprotected, 1);
});

test("bot history: the recorded days of the period and the bot's closed trades there, newest first", () => {
  const days = [
    { date: "2026-09-01", equity: 90_000 }, // before the week
    { date: "2026-10-01", equity: 100_000 },
    { date: "2026-10-02", equity: 101_000 },
    { date: "2026-10-05", equity: 99_000 },
  ];
  const closed = position({
    id: "c1",
    status: "closed",
    qty: 0,
    closedAt: Date.parse("2026-10-02T19:50:00Z"),
    sales: [
      {
        at: Date.parse("2026-10-02T15:00:00Z"),
        qty: 1,
        reason: "check-10",
        jobId: "s1",
        settled: true,
        price: 1.5,
      },
      {
        at: Date.parse("2026-10-02T19:50:00Z"),
        qty: 2,
        reason: "close-1550",
        jobId: "s2",
        settled: true,
        price: 0.8,
      },
    ],
  });
  const older = position({
    id: "c0",
    status: "closed",
    qty: 0,
    openedAt: Date.parse("2026-09-01T14:00:00Z"),
    closedAt: Date.parse("2026-09-01T19:50:00Z"),
    sales: [
      {
        at: Date.parse("2026-09-01T19:50:00Z"),
        qty: 3,
        reason: "close-1550",
        jobId: "s0",
        settled: true,
        price: 2,
      },
    ],
  });
  const dry = position({
    id: "d1",
    dry: true,
    status: "closed",
    closedAt: noon,
  });
  const result = botHistory(
    days,
    [older, position({}), closed, dry],
    "1W",
    true,
    noon,
  );
  assert.equal(result.status, 200);
  const h = result.body as Extract<typeof result.body, { points: unknown }>;
  assert.equal(h.period, "1W");
  assert.equal(h.baseEquity, 100_000);
  assert.deepEqual(
    h.points.map((p) => [p.date, p.pnl]),
    [
      ["2026-10-01", 0],
      ["2026-10-02", 1000],
      ["2026-10-05", -1000],
    ],
  );
  assert.deepEqual([h.pnl, h.pnlPct], [-1000, -1]);
  // One trade: bought 3 at 1.00, sold 1 at 1.50 and 2 at 0.80.
  assert.equal(h.trades.length, 1);
  const t = h.trades[0]!;
  assert.deepEqual(
    [t.symbol, t.qty, t.entry, t.expired],
    [nvda, 3, 1.0, false],
  );
  assert.ok(Math.abs(t.exit - 3.1 / 3) < 1e-9);
  assert.ok(Math.abs(t.pnl - 10) < 1e-9);
  assert.deepEqual(
    t.fills?.map((f) => [f.side, f.qty, f.price]),
    [
      ["buy", 3, 1.0],
      ["sell", 1, 1.5],
      ["sell", 2, 0.8],
    ],
  );
  assert.deepEqual([h.realized, h.wins], [t.pnl, 1]);
  // The year shows the older trade too; a bad period is refused.
  const year = botHistory(days, [older, closed], "1A", true, noon);
  assert.equal((year.body as { trades: unknown[] }).trades.length, 2);
  assert.equal(botHistory(days, [], "2Y", true, noon).status, 400);
  // No record yet: an empty, valid history.
  const none = botHistory([], [], undefined, true, noon);
  assert.deepEqual(
    (none.body as { points: unknown[]; period: string }).points,
    [],
  );
  assert.equal((none.body as { period: string }).period, "1M");
});
