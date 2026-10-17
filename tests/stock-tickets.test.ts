// SYNTHETIC stock quotes; the broker is simulated in memory.
import assert from "node:assert/strict";
import test from "node:test";
import { RequestError, TraderService } from "../apps/trader/src/service.js";
import { TradeStore } from "../apps/trader/src/store.js";
import { TradeEngine } from "../packages/trading/src/engine.js";
import { TelegramNotifier } from "../packages/trading/src/notifier.js";
import type { OpenOrder } from "../packages/trading/src/broker.js";
import { SimBroker } from "../packages/trading/src/sim-broker.js";
import {
  stockChange,
  stockTicket,
} from "../packages/trading/src/stock-tickets.js";

const context = {
  quote: { bid: 100, ask: 100.1, last: 100.05 },
  held: 10,
  open: [] as OpenOrder[],
  marketOpen: true,
};
const ticket = (input: Record<string, unknown>, c = context) =>
  stockTicket("AAPL", input, c);

test("ticket: each type needs its own prices and nothing else", () => {
  assert.equal(
    ticket({ side: "buy", type: "market", qty: 1 }).ticket.type,
    "market",
  );
  assert.throws(
    () => ticket({ side: "buy", type: "limit", qty: 1 }),
    /limitPrice: a limit order needs one/,
  );
  assert.throws(
    () => ticket({ side: "buy", type: "market", qty: 1, limitPrice: 5 }),
    /limitPrice: a market order has none/,
  );
  assert.throws(
    () => ticket({ side: "sell", type: "stop_limit", qty: 1, stopPrice: 95 }),
    /limitPrice: a stop limit order needs one/,
  );
  assert.throws(
    () =>
      ticket({
        side: "sell",
        type: "trailing_stop",
        qty: 1,
        trailPercent: 5,
        trailPrice: 2,
      }),
    /trail: a trailing stop needs trailPercent or trailPrice, not both/,
  );
  const trail = ticket({
    side: "sell",
    type: "trailing_stop",
    qty: 1,
    trailPercent: 5,
    timeInForce: "gtc",
  }).ticket;
  assert.deepEqual(trail, {
    symbol: "AAPL",
    side: "sell",
    qty: 1,
    type: "trailing_stop",
    timeInForce: "gtc",
    trailPercent: 5,
  });
});

test("ticket: time in force and extended hours follow the broker's rules", () => {
  assert.equal(
    ticket({ side: "buy", type: "market", qty: 1 }).ticket.timeInForce,
    "day",
  );
  assert.throws(
    () =>
      ticket({
        side: "sell",
        type: "stop",
        qty: 1,
        stopPrice: 95,
        timeInForce: "ioc",
      }),
    /ioc is not offered for a stop order; use day or gtc/,
  );
  assert.ok(
    ticket({
      side: "buy",
      type: "limit",
      qty: 1,
      limitPrice: 99,
      timeInForce: "opg",
    }),
  );
  assert.ok(
    ticket({
      side: "buy",
      type: "limit",
      qty: 1,
      limitPrice: 99,
      timeInForce: "gtc",
      extendedHours: true,
    }).ticket.extendedHours,
  );
  assert.throws(
    () => ticket({ side: "buy", type: "market", qty: 1, extendedHours: true }),
    /only a limit order with day or gtc/,
  );
  assert.throws(
    () =>
      ticket({
        side: "buy",
        type: "limit",
        qty: 1,
        limitPrice: 99,
        timeInForce: "ioc",
        extendedHours: true,
      }),
    /extendedHours/,
  );
});

test("ticket: prices must be on the tick", () => {
  assert.throws(
    () => ticket({ side: "buy", type: "limit", qty: 1, limitPrice: 99.123 }),
    /not a valid price/,
  );
  assert.ok(ticket({ side: "buy", type: "limit", qty: 1, limitPrice: 0.5123 }));
  assert.throws(
    () => ticket({ side: "buy", type: "limit", qty: 1, limitPrice: -1 }),
    /above zero/,
  );
});

test("ticket: a sell never goes beyond the free shares (never short)", () => {
  // 10 held, 4 already offered by an open stop.
  const open = [
    {
      id: "o1",
      symbol: "AAPL",
      side: "sell",
      qty: 4,
      filledQty: 0,
      status: "new",
      filledAvgPrice: null,
      limitPrice: null,
      stopPrice: 90,
    },
  ];
  const c = { ...context, open };
  assert.equal(
    ticket({ side: "sell", type: "market", qty: "all" }, c).ticket.qty,
    6,
  );
  assert.equal(
    ticket({ side: "sell", type: "market", qty: "half" }, c).ticket.qty,
    3,
  );
  assert.throws(
    () => ticket({ side: "sell", type: "limit", qty: 7, limitPrice: 101 }, c),
    /only 6 shares are free to sell; selling more would open a short position/,
  );
  assert.throws(
    () =>
      ticket({ side: "sell", type: "market", qty: 1 }, { ...context, held: 0 }),
    /no AAPL shares are held/,
  );
  assert.throws(
    () => ticket({ side: "sell", type: "market", amount: 500 }),
    /a sell is sized in shares/,
  );
});

test("ticket: dollars become whole shares at the order's own price", () => {
  // A limit buy is counted at its limit, a market buy at the ask.
  assert.equal(
    ticket({ side: "buy", type: "limit", amount: 1000, limitPrice: 95 }).ticket
      .qty,
    10,
  );
  assert.equal(
    ticket({ side: "buy", type: "market", amount: 1000 }).ticket.qty,
    9,
  );
  assert.throws(
    () => ticket({ side: "buy", type: "market", amount: 50 }),
    /does not buy one share/,
  );
});

test("ticket: notes for a stop that triggers at once and a closed market", () => {
  const n = ticket(
    { side: "sell", type: "stop", qty: 1, stopPrice: 101 },
    { ...context, marketOpen: false },
  ).notes;
  assert.ok(n.some((x) => /triggers at once/.test(x)));
  assert.ok(n.some((x) => /market is closed/.test(x)));
});

test("change: a sell may grow only into free shares", () => {
  const order = {
    id: "o1",
    symbol: "AAPL",
    side: "sell",
    qty: 4,
    filledQty: 0,
    status: "new",
    filledAvgPrice: null,
    limitPrice: 105,
    stopPrice: null,
    type: "limit",
  };
  const other = {
    ...order,
    id: "o2",
    qty: 5,
    type: "stop",
    stopPrice: 90,
    limitPrice: null,
  };
  const c = { held: 10, open: [order, other] };
  assert.deepEqual(stockChange(order, { qty: 5 }, c), { qty: 5 });
  assert.throws(
    () => stockChange(order, { qty: 6 }, c),
    /only 5 shares are free/,
  );
  assert.throws(
    () => stockChange(order, { stopPrice: 90 }, c),
    /a limit order has none/,
  );
  assert.throws(() => stockChange(order, {}, c), /nothing to change/);
  assert.deepEqual(
    stockChange(order, { limitPrice: 106, timeInForce: "gtc" }, c),
    {
      limitPrice: 106,
      timeInForce: "gtc",
    },
  );
});

function setup() {
  const store = new TradeStore(":memory:");
  const broker = new SimBroker();
  const notifier = new TelegramNotifier({
    send: async () => ({ ok: true, messageId: 1 }),
  });
  const engine = new TradeEngine({
    broker,
    notifier,
    posts: store.posts("owner"),
    buys: store.buys("owner"),
    sleep: async () => {},
  });
  const service = new TraderService({
    userId: "owner",
    store,
    engine,
    broker,
    notifier,
    sleep: async () => {},
  });
  // Sends and narrows the answer to a sent order.
  const send = async (body: Record<string, unknown>) => {
    const answer = await service.stockOrder(body);
    assert.equal(answer.status, "sent");
    return answer as Extract<typeof answer, { status: "sent" }>;
  };
  return { broker, service, send };
}

test("service: market buy, then a resting stop and a trailing stop that fire", async () => {
  const { broker, service, send } = setup();
  broker.setStockQuote("AAPL", 100, 100.1);
  const buy = await send({
    symbol: "AAPL",
    side: "buy",
    type: "market",
    qty: 10,
  });
  assert.equal(buy.status, "sent");
  assert.equal(buy.filledQty, 10);
  assert.equal(buy.avgPrice, 100.1);

  const stop = await send({
    symbol: "aapl",
    side: "sell",
    type: "stop",
    qty: 4,
    stopPrice: 95,
    timeInForce: "gtc",
  });
  assert.equal(stop.orderStatus, "new");
  // The stop's shares are no longer free: a sale of all sells the other 6.
  const trail = await send({
    symbol: "AAPL",
    side: "sell",
    type: "trailing_stop",
    qty: "all",
    trailPrice: 2,
  });
  assert.equal(trail.qty, 6);
  assert.deepEqual(trail.shortRisks, []);
  await assert.rejects(
    service.stockOrder({
      symbol: "AAPL",
      side: "sell",
      type: "market",
      qty: 1,
    }),
    (e: unknown) =>
      e instanceof RequestError && /already offered/.test(e.message),
  );

  // Up to 110: the trail follows to 108. Down to 107.5: it sells.
  broker.setStockQuote("AAPL", 110, 110.1);
  broker.setStockQuote("AAPL", 107.5, 107.6);
  const quote = await service.stockQuote({ symbol: "AAPL" });
  assert.equal(quote.held, 4);
  assert.equal(quote.openOrders.length, 1);
  assert.equal(quote.openOrders[0]!.type, "stop");
  assert.equal(quote.openOrders[0]!.timeInForce, "gtc");

  // The stop moves up, then fires.
  await service.changeOrder({
    orderId: quote.openOrders[0]!.orderId,
    stopPrice: 105,
  });
  broker.setStockQuote("AAPL", 104.9, 105);
  assert.equal((await service.stockQuote({ symbol: "AAPL" })).held, 0);
});

test("service: a check sends nothing; ioc that cannot fill is canceled", async () => {
  const { broker, service, send } = setup();
  broker.setStockQuote("MSFT", 400, 400.2);
  const checked = await service.stockOrder({
    symbol: "MSFT",
    side: "buy",
    type: "limit",
    limitPrice: 399,
    amount: 4000,
    check: true,
  });
  assert.equal(checked.status, "checked");
  assert.equal(checked.qty, 10);
  assert.equal(checked.estimatedCost, 3990);
  assert.equal(broker.orders.size, 0);

  const ioc = await send({
    symbol: "MSFT",
    side: "buy",
    type: "limit",
    limitPrice: 399,
    qty: 1,
    timeInForce: "ioc",
  });
  assert.equal(ioc.orderStatus, "canceled");
  assert.equal(
    (await service.stockQuote({ symbol: "MSFT" })).openOrders.length,
    0,
  );
});

test("service: a stop limit buy waits for its stop, then fills at its limit", async () => {
  const { broker, service, send } = setup();
  broker.setStockQuote("NVDA", 180, 180.1);
  const sent = await send({
    symbol: "NVDA",
    side: "buy",
    type: "stop_limit",
    stopPrice: 185,
    limitPrice: 186,
    qty: 2,
  });
  assert.equal(sent.orderStatus, "new");
  broker.setStockQuote("NVDA", 185.5, 185.6);
  const q = await service.stockQuote({ symbol: "NVDA" });
  assert.equal(q.held, 2);
  assert.equal(q.avgEntryPrice, 186);
});

test("service: an open stock sell does not block option buys or read as short", async () => {
  const { broker, service, send } = setup();
  broker.setStockQuote("AAPL", 100, 100.1);
  await send({
    symbol: "AAPL",
    side: "buy",
    type: "market",
    qty: 5,
  });
  await send({
    symbol: "AAPL",
    side: "sell",
    type: "limit",
    limitPrice: 120,
    qty: 5,
    timeInForce: "gtc",
  });
  await send({
    symbol: "AAPL",
    side: "buy",
    type: "limit",
    limitPrice: 90,
    qty: 1,
    timeInForce: "gtc",
  });
  const status = await service.status();
  assert.deepEqual(status.shortRisks, []);
  assert.equal(status.openOrders.length, 2);
  assert.ok(status.openOrders.every((o) => o.timeInForce === "gtc"));
});
