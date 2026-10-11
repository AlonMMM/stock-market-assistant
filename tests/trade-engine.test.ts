import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryBuyLog,
  MemoryPostStore,
  TradeEngine,
} from "../packages/trading/src/engine.js";
import {
  NoNotifier,
  TelegramNotifier,
} from "../packages/trading/src/notifier.js";
import { SimBroker } from "../packages/trading/src/sim-broker.js";

// Synthetic contracts and quotes; the broker is simulated in memory.
const friday = "NVDA261016C00240000";
const near = "NVDA261012C00235000";
const monday = Date.parse("2026-10-12T15:00:00Z");

function setup(telegram = true) {
  const broker = new SimBroker(100_000);
  broker.setQuote(friday, 1.0, 1.04, 0.12);
  broker.setQuote(near, 0.2, 0.21, 0.09);
  // The price raises stop below the ask; a seller meets the buy at 1.03.
  broker.fillAt.set(friday, 1.03);
  broker.fillAt.set(near, 0.2);
  const sent: { html: string; replyTo?: number }[] = [];
  let id = 100;
  const notifier = telegram
    ? new TelegramNotifier({
        send: async (html, options) => {
          sent.push({ html, ...(options?.replyTo ? options : {}) });
          return { ok: true, messageId: id++ };
        },
      })
    : new NoNotifier();
  const clock = { now: monday };
  const engine = new TradeEngine({
    broker,
    notifier,
    posts: new MemoryPostStore(),
    buys: new MemoryBuyLog(),
    now: () => clock.now,
    sleep: async () => {},
  });
  return { broker, engine, sent, clock };
}

test("engine preview: both expiries, sized and with the stop, nothing sent", async () => {
  const { broker, engine } = setup();
  const p = await engine.preview({
    underlying: "nvda",
    right: "call",
    sizePct: 0.5,
  });
  assert.equal(p.paper, true);
  assert.equal(p.targetDelta, "0.10–0.15");
  assert.deepEqual(
    p.rows.map((r) => [r.expiry, "contract" in r && r.contract]),
    [
      ["2026-10-12", near],
      ["2026-10-16", friday],
    ],
  );
  const row = p.rows[1]!;
  assert.ok("qty" in row && row.deltaInRange === true && row.qty === 4);
  assert.equal(broker.orders.size, 0);
});

test("engine buy: fills, places the stop and posts the entry", async () => {
  const { broker, engine, sent } = setup();
  const out = await engine.buy({ contract: friday, sizePct: 0.5 });
  assert.ok("stop" in out && out.stop);
  assert.equal(out.result.status, "filled");
  const paid = out.result.order!.filledAvgPrice!;
  assert.equal(out.stop.qty, 4);
  assert.equal(out.stop.price, Number((paid * 0.6).toFixed(2)));
  assert.deepEqual(out.post, { ok: true, ref: "100" });
  assert.match(sent[0]!.html, /\$NVDA \| 240 Call 10\/16/);
  const stops = await broker.openOrders(friday);
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.qty, 4);
  assert.deepEqual((await engine.shortCheck()).problems, []);
});

test("engine buy: a wide spread is refused, nothing sent, nothing posted", async () => {
  const { broker, engine, sent } = setup();
  broker.setQuote(friday, 1.0, 1.3, 0.12);
  const out = await engine.buy({ contract: friday, sizePct: 0.5 });
  assert.ok("refused" in out);
  assert.match(out.refused.join(), /^spread: 26\.09% of the mid/);
  assert.equal(broker.orders.size, 0);
  assert.equal(sent.length, 0);
});

test("engine buy: an order that never fills is canceled, no stop, no post", async () => {
  const { broker, engine, sent } = setup();
  broker.fillAt.set(friday, 5);
  const out = await engine.buy({ contract: friday, sizePct: 0.5 });
  assert.ok("stop" in out && out.stop);
  assert.equal(out.canceledQty, 4);
  assert.equal(out.stop.price, undefined);
  assert.equal((await broker.openOrders()).length, 0);
  assert.equal(sent.length, 0);
});

test("engine buy: a stop above 70% is refused before any order", async () => {
  const { broker, engine } = setup();
  const out = await engine.buy({ contract: friday, sizePct: 0.5, stopPct: 80 });
  assert.ok("refused" in out);
  assert.match(out.refused.join(), /^stop: stop 80% is outside 0–70%/);
  assert.equal(broker.orders.size, 0);
});

test("engine buy in one step: picks Friday's contract by default, or the named expiry", async () => {
  const { broker, engine, clock } = setup();
  const out = await engine.buy({
    underlying: "nvda",
    right: "call",
    sizePct: 0.5,
  });
  assert.equal(out.contract, friday);
  assert.ok("stop" in out && out.stop?.qty === 4);
  // The nearest expiry has no strike inside 0.10–0.15: refused, not bought.
  clock.now += 5 * 60_000;
  const nearest = await engine.buy({
    underlying: "NVDA",
    right: "call",
    sizePct: 0.5,
    expiry: "nearest",
  });
  assert.equal(nearest.contract, near);
  assert.ok("refused" in nearest);
  assert.match(nearest.refused.join(), /delta in range: delta 0\.090/);
  // A named delta is a target, not a range.
  const named = await engine.buy({
    underlying: "NVDA",
    right: "call",
    sizePct: 0.5,
    expiry: "2026-10-12",
    delta: 0.09,
  });
  assert.ok(!("refused" in named));
  await assert.rejects(
    engine.buy({
      underlying: "NVDA",
      right: "call",
      sizePct: 0.5,
      expiry: "2026-11-20",
    }),
    /offered: 2026-10-12, 2026-10-16/,
  );
  assert.equal((await broker.positions()).length, 2);
});

test("engine buy: a doubled command is refused; a buy that filled nothing is not counted", async () => {
  const { broker, engine, clock } = setup();
  await engine.buy({ contract: friday, sizePct: 0.5 });
  const again = await engine.buy({ contract: friday, sizePct: 0.5 });
  assert.ok("refused" in again);
  assert.match(
    again.refused.join(),
    /not a repeat: NVDA calls were bought 0 s ago/,
  );
  clock.now += 61_000;
  broker.fillAt.set(friday, 5); // nobody sells: the order is canceled
  const unfilled = await engine.buy({ contract: friday, sizePct: 0.5 });
  assert.ok("canceledQty" in unfilled);
  assert.equal(
    (await engine.preview({ underlying: "NVDA", right: "call", sizePct: 0.5 }))
      .buysToday,
    1,
  );
});

test("engine buy: the kill switch refuses buys; sells still work", async () => {
  const { broker, engine } = setup();
  await engine.buy({ contract: friday, sizePct: 0.5 });
  const off = new TradeEngine({
    broker,
    notifier: new NoNotifier(),
    posts: new MemoryPostStore(),
    buys: new MemoryBuyLog(),
    now: () => monday + 120_000,
    sleep: async () => {},
    enabled: false,
  });
  const out = await off.buy({ contract: friday, sizePct: 0.5 });
  assert.ok("refused" in out);
  assert.match(
    out.refused.join(),
    /trading switched on: trading is switched off/,
  );
  assert.equal(
    (await off.sell({ contract: friday, qty: "all" })).result.sold,
    4,
  );
});

test("engine sell: half by underlying, exit posted under the entry, stop on the rest", async () => {
  const { broker, engine, sent, clock } = setup();
  await engine.buy({ contract: friday, sizePct: 0.5 });
  broker.setQuote(friday, 1.5, 1.54, 0.2);
  const out = await engine.sell({ underlying: "NVDA", qty: "half" });
  assert.equal(out.result.sold, 2);
  assert.equal(out.result.remaining, 2);
  assert.equal(sent[1]!.replyTo, 100);
  assert.match(sent[1]!.html, /Sold 2 of 4 at 1\.50/);
  const open = await broker.openOrders(friday);
  assert.deepEqual(
    open.map((o) => [o.side, o.qty, o.stopPrice !== null]),
    [["sell", 2, true]],
  );
  // Selling the rest closes the thread: a later trade starts a new post.
  await engine.sell({ contract: friday, qty: "all" });
  assert.equal(sent[2]!.replyTo, 100);
  assert.equal((await broker.positions()).length, 0);
  assert.equal((await broker.openOrders()).length, 0);
  clock.now += 5 * 60_000;
  await engine.buy({ contract: friday, sizePct: 0.5 });
  await engine.sell({ contract: friday, qty: "all" });
  assert.equal(sent[4]!.replyTo, 103);
});

test("engine: without a channel the trade still runs and says so", async () => {
  const { engine } = setup(false);
  const out = await engine.buy({ contract: friday, sizePct: 0.5 });
  assert.ok("post" in out && out.post && !out.post.ok);
  assert.match(out.post.error, /No notification channel/);
});

test("engine stop: covers only contracts no sell order already covers", async () => {
  const { broker, engine } = setup();
  await engine.buy({ contract: friday, sizePct: 0.5 });
  const again = await engine.setStop({ contract: friday });
  assert.ok("note" in again);
  assert.equal((await broker.openOrders(friday)).length, 1);
});

test("engine short check: a short position is alerted", async () => {
  const { broker, engine, sent } = setup();
  broker.positions = async () => [
    { symbol: friday, qty: -1, avgEntryPrice: 1 },
  ];
  const out = await engine.shortCheck();
  assert.equal(out.problems.length, 1);
  assert.equal(out.alert?.ok, true);
  assert.match(sent[0]!.html, /SHORT OPTION RISK \(paper\)<\/b>\nSHORT NVDA/);
});
