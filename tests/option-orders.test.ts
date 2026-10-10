import assert from "node:assert/strict";
import test from "node:test";
import type {
  Order,
  TradingClient,
} from "../packages/trading/src/alpaca-trading.js";
import { buyWithLadder } from "../packages/trading/src/ladder.js";
import {
  ceilingPrice,
  comingFriday,
  expiryChoices,
  parseOccSymbol,
  pickByDelta,
  sizeContracts,
  spreadCheck,
  stepPrice,
  type OptionQuote,
} from "../packages/trading/src/options.js";

const q = (
  symbol: string,
  bid: number,
  ask: number,
  delta: number | null,
): OptionQuote => ({ ...parseOccSymbol(symbol), symbol, bid, ask, delta });

test("parses OCC symbols", () => {
  assert.deepEqual(parseOccSymbol("ORCL261016C00250000"), {
    underlying: "ORCL",
    expiry: "2026-10-16",
    right: "call",
    strike: 250,
  });
  assert.equal(parseOccSymbol("SPY261012P00512500").strike, 512.5);
  assert.throws(() => parseOccSymbol("ORCL"));
});

test("offers the nearest expiry and the coming Friday's", () => {
  assert.equal(comingFriday("2026-10-12"), "2026-10-16"); // Monday
  assert.equal(comingFriday("2026-10-16"), "2026-10-16"); // Friday
  assert.equal(comingFriday("2026-10-17"), "2026-10-23"); // Saturday
  assert.deepEqual(
    expiryChoices(["2026-10-14", "2026-10-16", "2026-10-23"], "2026-10-12"),
    { nearest: "2026-10-14", friday: "2026-10-16" },
  );
  // Friday holiday: Thursday's expiry stands in.
  assert.deepEqual(expiryChoices(["2026-11-26", "2026-12-04"], "2026-11-23"), {
    nearest: "2026-11-26",
    friday: "2026-11-26",
  });
  // Nothing listed this week.
  assert.deepEqual(expiryChoices(["2026-10-23"], "2026-10-12"), {
    nearest: "2026-10-23",
    friday: null,
  });
  assert.equal(expiryChoices(["2026-10-09"], "2026-10-12"), null);
});

test("picks the delta closest to the target, puts by magnitude", () => {
  const calls = [
    q("ORCL261016C00240000", 1.0, 1.1, 0.2),
    q("ORCL261016C00250000", 0.4, 0.44, 0.11),
    q("ORCL261016C00260000", 0.2, 0.22, 0.08),
    q("ORCL261016C00270000", 0, 0, 0.1), // no ask
    q("ORCL261016C00280000", 0.1, 0.12, null),
  ];
  assert.equal(pickByDelta(calls, 0.1)?.strike, 250);
  const puts = [
    q("ORCL261016P00200000", 0.3, 0.33, -0.09),
    q("ORCL261016P00210000", 0.5, 0.55, -0.12),
  ];
  assert.equal(pickByDelta(puts, 0.1)?.strike, 200);
  assert.equal(pickByDelta([], 0.1), null);
});

test("spread check: more than 10% of the mid fails", () => {
  assert.equal(spreadCheck({ bid: 1.0, ask: 1.1 }).ok, true); // 9.5%
  assert.equal(spreadCheck({ bid: 0.95, ask: 1.05 }).ok, true); // exactly 10%
  assert.equal(spreadCheck({ bid: 0.9, ask: 1.1 }).ok, false); // 20%
  assert.equal(spreadCheck({ bid: 0, ask: 0.05 }).ok, false); // no bid
});

test("prices climb from the mid to 85% of the way to the ask", () => {
  const quote = { bid: 1.0, ask: 1.2 }; // mid 1.10, ceiling 1.185 → 1.18
  assert.equal(ceilingPrice(quote), 1.18);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((i) => stepPrice(quote, i, 5)),
    [1.1, 1.11, 1.13, 1.14, 1.16, 1.18],
  );
  // Nickel ticks from $3.
  assert.equal(ceilingPrice({ bid: 4.0, ask: 4.4 }), 4.35);
});

test("sizes whole contracts within the size, capped at 3%", () => {
  assert.deepEqual(sizeContracts(100000, 0.5, 1.17), {
    qty: 4,
    budget: 500,
    cost: 468,
  });
  assert.equal(sizeContracts(100000, 0.5, 6).qty, 0);
  assert.equal(sizeContracts(100000, 3, 1).qty, 30);
  assert.throws(() => sizeContracts(100000, 3.5, 1), /at most 3%/);
  assert.throws(() => sizeContracts(100000, 0, 1));
});

const symbol = "ORCL261016C00250000";

function fakeClient(quotes: Array<[number, number]>, fillAt: number | null) {
  let n = 0;
  let current: Order;
  const calls: string[] = [];
  const next = () => quotes[Math.min(n++, quotes.length - 1)]!;
  const fill = (o: Order): Order =>
    fillAt !== null && (o.limitPrice ?? 0) >= fillAt - 1e-9
      ? {
          ...o,
          status: "filled",
          filledQty: o.qty,
          filledAvgPrice: o.limitPrice,
        }
      : o;
  const client: TradingClient = {
    quote: async () => {
      const [bid, ask] = next();
      return q(symbol, bid, ask, 0.1);
    },
    buyLimit: async (s, qty, price) => {
      calls.push(`buy ${qty} @ ${price}`);
      current = {
        id: "1",
        symbol: s,
        status: "new",
        qty,
        filledQty: 0,
        filledAvgPrice: null,
        limitPrice: price,
      };
      return current;
    },
    replace: async (_id, price) => {
      calls.push(`replace @ ${price}`);
      current = {
        ...current,
        id: String(Number(current.id) + 1),
        limitPrice: price,
      };
      return current;
    },
    order: async () => (current = fill(current)),
  };
  return { client, calls };
}

const fast = { sleep: async () => {}, steps: 5 };

test("ladder: does not send when the spread is too wide", async () => {
  const { client, calls } = fakeClient([[0.9, 1.1]], null);
  const result = await buyWithLadder(client, symbol, 3, fast);
  assert.equal(result.status, "rejected-spread");
  assert.deepEqual(calls, []);
});

test("ladder: raises until filled", async () => {
  const { client, calls } = fakeClient([[1.0, 1.1]], 1.07);
  const result = await buyWithLadder(client, symbol, 3, fast);
  assert.equal(result.status, "filled");
  assert.deepEqual(calls, ["buy 3 @ 1.05", "replace @ 1.06", "replace @ 1.07"]);
});

test("ladder: stops at the ceiling and leaves the order working", async () => {
  const { client, calls } = fakeClient([[1.0, 1.1]], null);
  const result = await buyWithLadder(client, symbol, 3, fast);
  assert.equal(result.status, "open");
  assert.equal(result.prices.at(-1), 1.09);
  assert.equal(calls.length, 5);
});

test("ladder: stops raising when the spread widens", async () => {
  const { client, calls } = fakeClient(
    [
      [1.0, 1.1],
      [1.0, 1.1],
      [0.9, 1.2],
    ],
    null,
  );
  const result = await buyWithLadder(client, symbol, 3, { ...fast, steps: 2 });
  assert.equal(result.spreadWidened, true);
  assert.equal(calls.length, 2);
});

test("ladder: never pays above the budget cap", async () => {
  const { client } = fakeClient([[1.0, 1.1]], null);
  const result = await buyWithLadder(client, symbol, 3, {
    ...fast,
    maxPrice: 1.075,
  });
  assert.equal(Math.max(...result.prices), 1.07);
  const below = await buyWithLadder(
    fakeClient([[1.0, 1.1]], null).client,
    symbol,
    3,
    {
      ...fast,
      maxPrice: 1.0,
    },
  );
  assert.equal(below.status, "rejected-budget");
});
