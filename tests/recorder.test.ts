import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordingBroker } from "../apps/trader/src/order-recorder.js";
import { PriceRecorder } from "../apps/trader/src/price-recorder.js";
import { RecorderStore } from "../apps/trader/src/recorder-store.js";
import type { Broker, Order } from "../packages/trading/src/broker.js";
import { buyWithLadder } from "../packages/trading/src/ladder.js";
import type { OptionQuote } from "../packages/trading/src/options.js";

// Synthetic contracts and prices; the broker is a small fake in memory.
const contract = "RKLB261030C00080000";
const open = Date.parse("2026-10-29T16:00:00Z"); // 12:00 New York, a Thursday

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "recorder-"));
  const store = new RecorderStore(join(dir, "t.sqlite"));
  return {
    store,
    done: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const quoteOf = (bid: number, ask: number): OptionQuote =>
  ({ symbol: contract, bid, ask }) as unknown as OptionQuote;

/** A broker whose buy fills 20 at the second price and the rest at the third. */
function fakeBroker(clock: { t: number }) {
  const orders = new Map<string, Order>();
  let n = 0;
  let quotes = 0;
  const book = [quoteOf(1.36, 1.42), quoteOf(1.37, 1.43), quoteOf(1.38, 1.44)];
  const broker = {
    name: "fake",
    quote: async () => book[Math.min(quotes++, book.length - 1)]!,
    buyLimit: async (symbol: string, qty: number, limit: number) => {
      const o: Order = {
        id: `o${++n}`,
        symbol,
        status: "new",
        qty,
        filledQty: 0,
        filledAvgPrice: null,
        limitPrice: limit,
      };
      orders.set(o.id, o);
      return { ...o };
    },
    replace: async (id: string, limit: number) => {
      const old = orders.get(id)!;
      old.status = "replaced";
      const o: Order = {
        ...old,
        id: `o${++n}`,
        status: "new",
        limitPrice: limit,
        filledQty: 0,
        filledAvgPrice: null,
      };
      old.replacedBy = o.id;
      orders.set(o.id, o);
      // The raise fills 20 of 36 at once, at its price.
      if (n === 2)
        Object.assign(o, {
          status: "partially_filled",
          filledQty: 20,
          filledAvgPrice: limit,
        });
      return { ...o };
    },
    order: async (id: string) => {
      const o = orders.get(id)!;
      // The second raise: the other 16 fill at its price.
      if (o.id === "o3" && o.status !== "filled")
        Object.assign(o, {
          status: "filled",
          filledQty: 16,
          filledAvgPrice: o.limitPrice,
          filledAt: clock.t,
        });
      return { ...o };
    },
    cancel: async () => {},
    equity: async () => 100_000,
  };
  return broker as unknown as Broker;
}

test("order steps: the send, each raise, each fill at its own price, the end", async () => {
  const { store, done } = tempStore();
  const clock = { t: open };
  const broker = recordingBroker(fakeBroker(clock), {
    account: "bot",
    store,
    now: () => clock.t,
  });
  const result = await buyWithLadder(broker, contract, 36, {
    steps: 2,
    intervalMs: 1000,
    sleep: async (ms) => {
      clock.t += ms;
    },
  });
  assert.equal(result.status, "filled");
  const steps = store.steps(open, open + 60_000);
  const [first, second, third] = result.prices;
  assert.deepEqual(
    steps.map((s) => [s.event, s.qty, s.limit, s.price]),
    [
      ["sent", 36, first, null],
      ["raised", null, second, null],
      ["fill", 20, second, second],
      ["raised", null, third, null],
      ["filled", 16, third, third],
    ],
  );
  // Every step is of one chain, from the first order.
  assert.ok(steps.every((s) => s.rootId === "o1" && s.side === "buy"));
  // With the book read just before it, and the broker's own fill time.
  assert.equal(steps[0]!.bid, 1.36);
  assert.equal(steps[0]!.ask, 1.42);
  assert.equal(steps.at(-1)!.filledAt, clock.t);
  done();
});

test("order steps: an order from before the start is not recorded twice", async () => {
  const { store, done } = tempStore();
  const old: Order = {
    id: "x1",
    symbol: contract,
    status: "partially_filled",
    qty: 10,
    filledQty: 4,
    filledAvgPrice: 1.2,
    limitPrice: 1.2,
  };
  const fake = { order: async () => ({ ...old }) } as unknown as Broker;
  const broker = recordingBroker(fake, {
    account: "a",
    store,
    now: () => open,
  });
  await broker.order("x1");
  await broker.order("x1");
  assert.equal(store.steps(open, open + 1).length, 0);
  // A later fill of it is a step.
  Object.assign(old, { status: "filled", filledQty: 10, filledAvgPrice: 1.23 });
  await broker.order("x1");
  const [s] = store.steps(open, open + 1);
  assert.equal(s!.event, "filled");
  assert.equal(s!.qty, 6);
  assert.equal(s!.price, 1.25);
  assert.equal(s!.side, null);
  done();
});

test("price ticks: a held position every second, a watch with both legs every 5 s, regular hours only", async () => {
  const { store, done } = tempStore();
  const clock = { t: open };
  let legPicks = 0;
  const quote = async (c: string) =>
    c.includes("C") ? quoteOf(1.1, 1.2) : quoteOf(0.9, 1.0);
  const recorder = new PriceRecorder({
    store,
    now: () => clock.t,
    lastPrices: async (symbols) => new Map(symbols.map((s) => [s, 74.1])),
    targets: () => [
      { kind: "held", bot: "main", ref: "p1", symbol: "RKLB", contract, quote },
      {
        kind: "watch",
        bot: "volume",
        ref: "w1",
        symbol: "HIMS",
        quote,
        legs: async () => {
          legPicks++;
          return { call: "HIMS261030C00055000", put: "HIMS261030P00055000" };
        },
      },
    ],
  });
  for (let i = 0; i < 6; i++) {
    await recorder.tick();
    clock.t += 1000;
  }
  const held = store.ticks({ ref: "p1" });
  assert.equal(held.length, 6);
  assert.deepEqual(
    [held[0]!.phase, held[0]!.stock, held[0]!.bid, held[0]!.ask],
    ["held", 74.1, 1.1, 1.2],
  );
  const watch = store.ticks({ ref: "w1" });
  assert.equal(watch.length, 6);
  // The legs are picked once; quoted at 0 s and 5 s.
  assert.equal(legPicks, 1);
  assert.deepEqual(
    watch.map((w) => w.callBid),
    [1.1, null, null, null, null, 1.1],
  );
  assert.equal(watch[0]!.putAsk, 1.0);
  assert.ok(watch.every((w) => w.stock === 74.1 && w.phase === "watch"));
  // After the close: nothing.
  clock.t = Date.parse("2026-10-29T20:30:00Z");
  await recorder.tick();
  assert.equal(store.ticks({ ref: "p1" }).length, 6);
  assert.equal(store.prune(open + 3000), 3 + 3);
  done();
});

test("order steps: a sale re-priced to the bid, then filled", async () => {
  const { store, done } = tempStore();
  const orders = new Map<string, Order>();
  const fake = {
    quote: async () => quoteOf(1.0, 1.06),
    sellLimit: async (symbol: string, qty: number, limit: number) => {
      const o: Order = {
        id: "s1",
        symbol,
        status: "new",
        qty,
        filledQty: 0,
        filledAvgPrice: null,
        limitPrice: limit,
      };
      orders.set(o.id, o);
      return { ...o };
    },
    replace: async (id: string, limit: number) => {
      const o: Order = {
        ...orders.get(id)!,
        id: "s2",
        limitPrice: limit,
        status: "filled",
        filledQty: 36,
        filledAvgPrice: limit,
      };
      orders.set(o.id, o);
      return { ...o };
    },
  } as unknown as Broker;
  const broker = recordingBroker(fake, {
    account: "leg",
    store,
    now: () => open,
  });
  await broker.quote(contract);
  await broker.sellLimit(contract, 36, 1.02);
  await broker.replace("s1", 1.0);
  const steps = store.steps(open, open + 1);
  assert.deepEqual(
    steps.map((s) => [s.event, s.side, s.qty, s.limit, s.price, s.bid, s.ask]),
    [
      ["sent", "sell", 36, 1.02, null, 1.0, 1.06],
      ["repriced", "sell", null, 1.0, null, 1.0, 1.06],
      ["filled", "sell", 36, 1.0, 1.0, 1.0, 1.06],
    ],
  );
  done();
});
