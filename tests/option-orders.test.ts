import assert from "node:assert/strict";
import test from "node:test";
import type {
  Order,
  TradingClient,
} from "../packages/trading/src/alpaca-trading.js";
import { buyWithLadder } from "../packages/trading/src/ladder.js";
import {
  exitQty,
  sellAtBid,
  type ExitClient,
} from "../packages/trading/src/exit.js";
import { formatEntry, formatExit } from "../packages/trading/src/message.js";
import {
  protectFill,
  type ProtectClient,
} from "../packages/trading/src/protect.js";
import {
  ceilingPrice,
  comingFriday,
  defaultStopPct,
  expiryChoices,
  parseOccSymbol,
  pickByDelta,
  sizeContracts,
  spreadCheck,
  stepPrice,
  stopPrice,
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

test("ladder: a refused raise leaves the order working and is reported", async () => {
  const { client, calls } = fakeClient([[1.0, 1.1]], null);
  client.replace = async () => {
    throw new Error("cannot replace order in accepted status");
  };
  const result = await buyWithLadder(client, symbol, 3, fast);
  assert.equal(result.status, "open");
  assert.deepEqual(result.prices, [1.05]);
  assert.match(result.raiseError ?? "", /accepted status/);
  assert.deepEqual(calls, ["buy 3 @ 1.05"]);
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

test("stop: 40% of the premium by default, never more than 70%", () => {
  assert.equal(defaultStopPct, 40);
  assert.equal(stopPrice(1.0, 40), 0.6);
  assert.equal(stopPrice(0.5, 40), 0.3);
  // Rounded up to the tick: the loss stays within the percentage.
  assert.equal(stopPrice(1.69, 40), 1.02);
  assert.equal(stopPrice(5.2, 70), 1.56);
  assert.equal(stopPrice(10, 40), 6);
  assert.throws(() => stopPrice(1, 71), /at most 70%/);
  assert.throws(() => stopPrice(1, 0));
});

const entryResult = (order: Partial<Order>, prices: number[]) => ({
  status: "open" as const,
  quote: q(symbol, 1.0, 1.1, 0.1),
  spreadRatio: 0.05,
  prices,
  order: {
    id: "1",
    symbol,
    status: "new",
    qty: 9,
    filledQty: 0,
    filledAvgPrice: null,
    limitPrice: 1.05,
    ...order,
  },
});

test("entry post: contract, price, contracts and stop", () => {
  assert.equal(
    formatEntry(
      { symbol, paper: false, stop: { pct: 40, price: 0.64 } },
      entryResult({ filledQty: 9, filledAvgPrice: 1.06 }, [1.05, 1.06]),
    ),
    "<b>$ORCL | 250 Call 10/16</b>\nBought at 1.06\n9 contracts\nStop at 0.64 (-40%)",
  );
  assert.equal(
    formatEntry(
      { symbol, paper: true, stop: { pct: 40, price: 0.64 } },
      entryResult({ filledQty: 3, filledAvgPrice: 1.06 }, [1.05, 1.06]),
    ),
    "🧪 PAPER\n<b>$ORCL | 250 Call 10/16</b>\nBought at 1.06\n3 of 9 contracts\nStop at 0.64 (-40%)",
  );
  assert.equal(
    formatEntry(
      { symbol, paper: false, stop: { pct: 40 } },
      entryResult({}, [1.05]),
    ),
    "<b>$ORCL | 250 Call 10/16</b>\nBidding at 1.05, not filled yet\n9 contracts\nNo stop until it fills",
  );
});

// A buy order whose fills arrive poll by poll: `fills[i]` is the filled
// quantity seen on poll i (the last value repeats).
function watched(
  fills: number[],
  refuse: { stopWhileOpen?: boolean; cancel?: boolean } = {},
) {
  const calls: string[] = [];
  let polls = 0;
  let state = "new";
  let stops = 0;
  const buy = (filled: number): Order => ({
    id: "b",
    symbol,
    status: filled === 9 ? "filled" : state,
    qty: 9,
    filledQty: filled,
    filledAvgPrice: filled > 0 ? 1.0 : null,
    limitPrice: 1.09,
  });
  const stopOrder = (): Order => ({ ...buy(0), id: `s${++stops}` });
  const client: ProtectClient = {
    order: async () => buy(fills[Math.min(polls++, fills.length - 1)] ?? 0),
    sellStop: async (_s, qty, price) => {
      if (refuse.stopWhileOpen && state === "new")
        throw new Error("potential wash trade");
      calls.push(`stop ${qty} @ ${price}`);
      return stopOrder();
    },
    replaceStop: async (id, qty, price) => {
      calls.push(`replace ${id} to ${qty} @ ${price}`);
      return stopOrder();
    },
    cancel: async () => {
      if (refuse.cancel) throw new Error("cancel refused");
      calls.push("cancel");
      state = "canceled";
    },
  };
  return { client, calls, first: buy(fills[0] ?? 0) };
}
const quick = { sleep: async () => {}, waitMs: 9000, pollMs: 3000 };

test("after the raises: a full fill gets its stop and nothing is canceled", async () => {
  const { client, calls, first } = watched([9]);
  const result = await protectFill(client, first, 40, quick);
  assert.deepEqual(calls, ["stop 9 @ 0.6"]);
  assert.deepEqual(result.stop, { pct: 40, price: 0.6, qty: 9 });
  assert.equal(result.canceledQty, 0);
});

test("after the raises: the stop grows with later fills, the rest is canceled", async () => {
  const { client, calls, first } = watched([3, 3, 5, 5, 5]);
  const result = await protectFill(client, first, 40, quick);
  assert.deepEqual(calls, ["stop 3 @ 0.6", "replace s1 to 5 @ 0.6", "cancel"]);
  assert.deepEqual(result.stop, { pct: 40, price: 0.6, qty: 5 });
  assert.equal(result.canceledQty, 4);
  assert.equal(result.order.status, "canceled");
});

test("after the raises: an order that never fills is canceled without a stop", async () => {
  const { client, calls, first } = watched([0]);
  const result = await protectFill(client, first, 40, quick);
  assert.deepEqual(calls, ["cancel"]);
  assert.deepEqual(result.stop, { pct: 40 });
  assert.equal(result.canceledQty, 9);
});

test("after the raises: a fill during the cancel is still covered", async () => {
  const { client, calls, first } = watched([0, 0, 0, 2]);
  const result = await protectFill(client, first, 40, quick);
  assert.deepEqual(calls, ["cancel", "stop 2 @ 0.6"]);
  assert.equal(result.canceledQty, 7);
});

test("after the raises: a stop refused while the buy is open is retried after the cancel", async () => {
  const { client, calls, first } = watched([3], { stopWhileOpen: true });
  const result = await protectFill(client, first, 40, quick);
  assert.deepEqual(calls, ["cancel", "stop 3 @ 0.6"]);
  assert.deepEqual(result.stop, { pct: 40, price: 0.6, qty: 3 });
});

test("after the raises: a refused cancel is reported", async () => {
  const { client, first } = watched([3], { cancel: true });
  const result = await protectFill(client, first, 40, quick);
  assert.equal(result.cancelError, "cancel refused");
  assert.equal(result.canceledQty, 0);
  assert.deepEqual(result.stop, { pct: 40, price: 0.6, qty: 3 });
});

test("entry post: warns when the stop covers only part", () => {
  assert.match(
    formatEntry(
      { symbol, paper: false, stop: { pct: 40, price: 0.64, qty: 3 } },
      entryResult({ filledQty: 5, filledAvgPrice: 1.06 }, [1.05]),
    ),
    /Stop at 0\.64 \(-40%\)\n⚠️ The stop covers 3 of 5$/,
  );
});

// A held position with one stop. `bids[i]` is the bid on quote i; the sell
// order fills once its limit is at or below `fillAt`.
function holding(
  bids: number[],
  fillAt: number | null,
  held = 8,
  stopAt: number | null = 0.6,
) {
  const calls: string[] = [];
  let quotes = 0;
  let position = held;
  let stopOpen = stopAt !== null;
  let sale: Order | null = null;
  const client: ExitClient = {
    position: async () => {
      if (position === 0) throw new Error("position does not exist");
      return { qty: position, avgEntryPrice: 1.0 };
    },
    openOrders: async () =>
      stopOpen
        ? [
            {
              id: "stop",
              symbol,
              status: "new",
              qty: held,
              filledQty: 0,
              filledAvgPrice: null,
              limitPrice: null,
              side: "sell",
              stopPrice: stopAt,
            },
          ]
        : [],
    quote: async () =>
      q(symbol, bids[Math.min(quotes++, bids.length - 1)]!, 9, 0.1),
    sellLimit: async (_s, qty, price) => {
      calls.push(`sell ${qty} @ ${price}`);
      sale = {
        id: "1",
        symbol,
        status: "new",
        qty,
        filledQty: 0,
        filledAvgPrice: null,
        limitPrice: price,
      };
      return sale;
    },
    replace: async (_id, price) => {
      calls.push(`reprice @ ${price}`);
      sale = { ...sale!, id: String(Number(sale!.id) + 1), limitPrice: price };
      return sale;
    },
    order: async () => {
      const o = sale!;
      if (
        o.status === "new" &&
        fillAt !== null &&
        (o.limitPrice ?? 9) <= fillAt + 1e-9
      ) {
        position -= o.qty;
        sale = {
          ...o,
          status: "filled",
          filledQty: o.qty,
          filledAvgPrice: o.limitPrice,
        };
      }
      return sale!;
    },
    cancel: async (id) => {
      calls.push(`cancel ${id}`);
      if (id === "stop") stopOpen = false;
      else sale = { ...sale!, status: "canceled" };
    },
    sellStop: async (_s, qty, price) => {
      calls.push(`stop ${qty} @ ${price}`);
      return sale!;
    },
  };
  return { client, calls };
}
const brisk = { sleep: async () => {}, intervalMs: 5000, maxMs: 20000 };

test("sell quantity: all, half rounded up, or a number", () => {
  assert.equal(exitQty("all", 8), 8);
  assert.equal(exitQty("half", 8), 4);
  assert.equal(exitQty("half", 3), 2);
  assert.equal(exitQty("half", 1), 1);
  assert.equal(exitQty("3", 8), 3);
  assert.throws(() => exitQty("9", 8), /from 1 to 8/);
  assert.throws(() => exitQty("0", 8));
  assert.throws(() => exitQty("some", 8));
});

test("sell: half at the bid, then the stop goes back on the rest", async () => {
  const { client, calls } = holding([0.9], 0.9);
  const result = await sellAtBid(client, symbol, "half", brisk);
  assert.deepEqual(calls, ["cancel stop", "sell 4 @ 0.9", "stop 4 @ 0.6"]);
  assert.equal(result.sold, 4);
  assert.equal(result.price, 0.9);
  assert.equal(result.remaining, 4);
  assert.deepEqual(result.stop, { price: 0.6, qty: 4 });
  assert.equal(result.timedOut, false);
});

test("sell: follows the bid down every 5 seconds until it sells", async () => {
  const { client, calls } = holding([0.9, 0.9, 0.85, 0.8], 0.8);
  const result = await sellAtBid(client, symbol, "all", brisk);
  assert.deepEqual(calls, [
    "cancel stop",
    "sell 8 @ 0.9",
    "reprice @ 0.85",
    "reprice @ 0.8",
  ]);
  assert.equal(result.sold, 8);
  assert.equal(result.remaining, 0);
  assert.equal(result.stop, null);
  assert.equal(result.attempts, 3);
});

test("sell: gives up after the limit, cancels and restores the stop", async () => {
  const { client, calls } = holding([0.9], null);
  const result = await sellAtBid(client, symbol, "all", brisk);
  assert.deepEqual(calls, [
    "cancel stop",
    "sell 8 @ 0.9",
    "cancel 1",
    "stop 8 @ 0.6",
  ]);
  assert.equal(result.sold, 0);
  assert.equal(result.price, null);
  assert.equal(result.timedOut, true);
});

test("sell: a remainder that had no stop gets the default one", async () => {
  const { client, calls } = holding([0.9], 0.9, 8, null);
  await sellAtBid(client, symbol, "2", brisk);
  // 40% below the 1.00 entry.
  assert.deepEqual(calls, ["sell 2 @ 0.9", "stop 6 @ 0.6"]);
});

test("exit post: partial and full", () => {
  const base = {
    held: 8,
    entry: 1.0,
    asked: 4,
    attempts: 1,
    timedOut: false,
  };
  assert.equal(
    formatExit(
      { symbol, paper: true },
      {
        ...base,
        sold: 4,
        price: 1.5,
        remaining: 4,
        stop: { price: 0.6, qty: 4 },
      },
    ),
    "🧪 PAPER\n<b>$ORCL | 250 Call 10/16</b>\nSold 4 of 8 at 1.50\nProfit $200 (+50%)\nStop at 0.60 on the remaining 4",
  );
  assert.equal(
    formatExit(
      { symbol, paper: false },
      { ...base, sold: 8, price: 0.7, remaining: 0, stop: null },
    ),
    "<b>$ORCL | 250 Call 10/16</b>\nOut, sold 8 at 0.70\nLoss $240 (-30%)",
  );
});
