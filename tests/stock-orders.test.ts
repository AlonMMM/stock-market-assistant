// SYNTHETIC stock quotes; the broker is simulated in memory.
import assert from "node:assert/strict";
import test from "node:test";
import { RequestError, TraderService } from "../apps/trader/src/service.js";
import { TradeStore } from "../apps/trader/src/store.js";
import { TradeEngine } from "../packages/trading/src/engine.js";
import { TelegramNotifier } from "../packages/trading/src/notifier.js";
import { SimBroker } from "../packages/trading/src/sim-broker.js";
import {
  sellableShares,
  sharesFor,
  stockSellQty,
  stockStepPrice,
} from "../packages/trading/src/stock-orders.js";

test("stock limit steps from the mid to the ask (buy) or the bid (sell)", () => {
  const q = { bid: 100, ask: 100.1, last: 100.05 };
  assert.equal(stockStepPrice("buy", q, 0, 4), 100.05);
  assert.equal(stockStepPrice("buy", q, 2, 4), 100.08); // 100.075 rounded up
  assert.equal(stockStepPrice("buy", q, 4, 4), 100.1);
  assert.equal(stockStepPrice("sell", q, 0, 4), 100.05);
  assert.equal(stockStepPrice("sell", q, 2, 4), 100.02); // 100.025 rounded down
  assert.equal(stockStepPrice("sell", q, 4, 4), 100);
  // Never past the ask or bid, even past the last step.
  assert.equal(stockStepPrice("buy", q, 9, 4), 100.1);
  // One side only, or only a last trade.
  assert.equal(stockStepPrice("buy", { bid: null, ask: 5.5, last: 5 }, 0), 5.5);
  assert.equal(stockStepPrice("sell", { bid: null, ask: 5.5, last: 5 }, 0), 5);
  assert.equal(
    stockStepPrice("buy", { bid: null, ask: null, last: null }, 0),
    null,
  );
  // Below $1: hundredths of a cent.
  assert.equal(
    stockStepPrice("buy", { bid: 0.5, ask: 0.5003, last: null }, 0),
    0.5002,
  );
});

test("stock size and sell quantity rules", () => {
  assert.equal(sharesFor(1000, 333), 3);
  assert.equal(sharesFor(100, 333), 0);
  const open = [{ symbol: "AAPL", side: "sell", qty: 4, filledQty: 1 }];
  assert.equal(sellableShares(10, "AAPL", open), 7);
  assert.equal(sellableShares(-5, "AAPL", []), 0); // short: nothing to sell
  assert.equal(stockSellQty("all", 7), 7);
  assert.equal(stockSellQty("half", 7), 3);
  assert.equal(stockSellQty("half", 1), 1);
  assert.equal(stockSellQty("5", 7), 5);
  assert.throws(() => stockSellQty("8", 7), /short position/);
  assert.throws(() => stockSellQty("all", 0), /No shares/);
  assert.throws(() => stockSellQty("1.5", 7), /whole number/);
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
  return { broker, service };
}

test("site stock buy: whole shares from dollars, filled as the price steps up", async () => {
  const { broker, service } = setup();
  broker.setStockQuote("AAPL", 250, 250.2);
  const started = await service.stockBuy({ symbol: "aapl", amount: 2600 });
  assert.equal(started.status, "started");
  assert.deepEqual([started.symbol, started.qty], ["AAPL", 10]); // 2600 / 250.2
  await service.idle();
  const job = service.job(started.jobId);
  assert.equal(job.state, "done");
  const result = job.result as {
    status: string;
    filledQty: number;
    prices: number[];
    shortRisks: string[];
  };
  // Mid 250.10, then up to the ask, where the simulator fills.
  assert.equal(result.status, "filled");
  assert.equal(result.filledQty, 10);
  assert.equal(result.prices[0], 250.1);
  assert.equal(result.prices.at(-1), 250.2);
  assert.deepEqual(result.shortRisks, []);
  const quote = await service.stockQuote({ symbol: "AAPL" });
  assert.equal(quote.held, 10);
  assert.equal(quote.sellable, 10);
  // Stock positions do not show up as option positions.
  assert.deepEqual(await broker.positions(), []);
});

test("site stock sell: close-only, never more than held and free", async () => {
  const { broker, service } = setup();
  broker.setStockQuote("AAPL", 250, 250.2);
  await service.stockBuy({ symbol: "AAPL", qty: 10 });
  await service.idle();
  await assert.rejects(
    service.stockSell({ symbol: "AAPL", qty: 11 }),
    (e: unknown) =>
      e instanceof RequestError && /short position/.test(e.message),
  );
  await assert.rejects(
    service.stockSell({ symbol: "MSFT", qty: "all" }),
    /No long position in MSFT/,
  );
  // A resting sell (placed above the market) holds its shares.
  await broker.stockLimit("AAPL", "sell", 4, 300);
  assert.equal((await service.stockQuote({ symbol: "AAPL" })).sellable, 6);
  await assert.rejects(
    service.stockSell({ symbol: "AAPL", qty: 7 }),
    /Only 6 shares/,
  );
  // "half" of what is free, stepped down to the bid, where it fills.
  const half = await service.stockSell({ symbol: "AAPL", qty: "half" });
  assert.equal(half.selling, 3);
  await service.idle();
  const sold = service.job(half.jobId).result as {
    status: string;
    prices: number[];
  };
  assert.equal(sold.status, "filled");
  assert.equal(sold.prices.at(-1), 250);
  broker.setStockQuote("AAPL", 251, 251.1);
  const rest = await service.stockSell({ symbol: "AAPL", qty: "all" });
  assert.equal(rest.selling, 3);
  await service.idle();
  const quote = await service.stockQuote({ symbol: "AAPL" });
  assert.deepEqual([quote.held, quote.sellable], [4, 0]); // 4 on the resting sell
});

test("stock requests are validated", async () => {
  const { service } = setup();
  await assert.rejects(service.stockBuy({ symbol: "AAPL" }), /Give a size/);
  await assert.rejects(
    service.stockBuy({ symbol: "AAPL", qty: 1.5 }),
    /whole number/,
  );
  await assert.rejects(service.stockBuy({ symbol: "AAPL1", qty: 1 }), /symbol/);
  await assert.rejects(
    service.stockSell({ symbol: "AAPL", qty: "most" }),
    /qty must be/,
  );
});
