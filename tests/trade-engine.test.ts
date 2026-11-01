import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryBuyLog,
  MemoryPostStore,
  TradeEngine,
  TradeRefusal,
} from "../packages/trading/src/engine.js";
import {
  NoNotifier,
  TelegramNotifier,
} from "../packages/trading/src/notifier.js";
import { optionTicket } from "../packages/trading/src/option-tickets.js";
import { stopPrice } from "../packages/trading/src/options.js";
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

test("engine buy: forced, the spread is not checked and the order is bought", async () => {
  const { broker, engine, sent } = setup();
  broker.setQuote(friday, 1.0, 1.3, 0.12);
  broker.fillAt.set(friday, 1.2);
  const out = await engine.buy({ contract: friday, sizePct: 0.5, force: true });
  assert.ok("result" in out);
  assert.equal(out.result.status, "filled");
  assert.equal(out.stop?.qty, out.qty);
  assert.equal(sent.length, 1);
  // Only the spread is skipped: any other failed check still refuses.
  const big = await engine.buy({ contract: friday, sizePct: 5, force: true });
  assert.ok("refused" in big);
  assert.match(big.refused.join(), /^size: /);
});

test("engine buy: a named date beyond Friday is bought when it is listed", async () => {
  const { broker, engine } = setup();
  const later = "NVDA261023C00245000";
  broker.setQuote(later, 2.0, 2.06, 0.13);
  broker.fillAt.set(later, 2.04);
  const out = await engine.buy({
    underlying: "NVDA",
    right: "call",
    sizePct: 0.5,
    expiry: "2026-10-23",
  });
  assert.equal(out.contract, later);
  assert.ok("result" in out && out.result.status === "filled");
  const p = await engine.preview({
    underlying: "NVDA",
    right: "call",
    sizePct: 0.5,
    expiry: "2026-10-23",
  });
  assert.deepEqual(
    p.rows.map((r) => r.expiry),
    ["2026-10-12", "2026-10-16", "2026-10-23"],
  );
  await assert.rejects(
    engine.buy({
      underlying: "NVDA",
      right: "call",
      sizePct: 0.5,
      expiry: "2026-10-09",
    }),
    /^TradeRefusal: expiry: 2026-10-09 is in the past|expiry: 2026-10-09 is in the past/,
  );
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

test("engine buy in one step: the nearest expiry by default, Friday's when named", async () => {
  const { broker, engine, clock } = setup();
  const out = await engine.buy({
    underlying: "nvda",
    right: "call",
    sizePct: 0.5,
  });
  // The nearest expiry has no strike inside 0.10–0.15: the closest is bought.
  assert.equal(out.contract, near);
  assert.ok("stop" in out && out.stop?.qty === 25);
  clock.now += 5 * 60_000;
  const toFriday = await engine.buy({
    underlying: "NVDA",
    right: "call",
    sizePct: 0.5,
    expiry: "friday",
  });
  assert.equal(toFriday.contract, friday);
  clock.now += 5 * 60_000;
  const dated = await engine.buy({
    underlying: "NVDA",
    right: "call",
    sizePct: 0.5,
    expiry: "2026-10-16",
  });
  assert.equal(dated.contract, friday);
  await assert.rejects(
    engine.buy({
      underlying: "NVDA",
      right: "call",
      sizePct: 0.5,
      expiry: "2026-11-20",
    }),
    (error) =>
      error instanceof TradeRefusal &&
      /^expiry: no NVDA calls expire on 2026-11-20/.test(error.message) &&
      error.hint === "Offered: 2026-10-12 (nearest), 2026-10-16 (Friday).",
  );
  assert.equal((await broker.positions()).length, 2);
  const preview = await engine.preview({
    underlying: "NVDA",
    right: "call",
    sizePct: 0.5,
  });
  assert.equal(preview.defaultExpiry, "nearest");
  const row = preview.rows[0]!;
  assert.ok("notes" in row);
  assert.match(
    row.notes.join(),
    /delta: no strike of this expiry is in the range/,
  );
});

test("engine buy off hours: the order waits, is worked at the open, and the posts say so", async () => {
  const { broker, engine, sent } = setup();
  broker.isOpen = false;
  broker.fillAt.set(friday, 5); // nobody sells while the market is closed
  let sleeps = 0;
  const waitingEngine = new TradeEngine({
    broker,
    notifier: new TelegramNotifier({
      send: async (html) => {
        sent.push({ html });
        return { ok: true, messageId: 7 };
      },
    }),
    posts: new MemoryPostStore(),
    buys: new MemoryBuyLog(),
    now: () => monday,
    sleep: async () => {
      // The market opens during the third wait, and sellers arrive.
      if (++sleeps === 3) {
        broker.isOpen = true;
        broker.fillAt.set(friday, 1.03);
        broker.setQuote(friday, 1.0, 1.04, 0.12);
      }
    },
  });
  void engine;
  const stages: string[] = [];
  const plan = await waitingEngine.planBuy({ contract: friday, sizePct: 0.5 });
  assert.ok(!("refused" in plan));
  assert.equal(plan.offHours, true);
  const out = await waitingEngine.runBuy(plan, (p) => stages.push(p.stage));
  assert.equal(stages[0], "waiting for the market to open");
  assert.equal(out.offHours, true);
  assert.equal(out.result.order!.filledQty, 4);
  assert.equal(out.stop?.qty, 4);
  // One order only: the waiting one was raised, no second order was sent.
  assert.equal(
    [...broker.orders.values()].filter((o) => o.side === "buy").length,
    1,
  );
  assert.match(
    sent[0]!.html,
    /^🕒 <b>Off-hours order \(paper\)<\/b>\n\$NVDA \| 240 Call 2026-10-16\n4 contracts, bidding 1\.02/,
  );
  assert.match(
    sent[1]!.html,
    /Bought at 1\.03\n4 contracts\n0\.4% of the portfolio\nOrdered off hours\nStop at/,
  );
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
  // An intended add (the bot's pyramid) passes the repeat check, and only it.
  const add = await engine.planBuy({
    contract: friday,
    sizePct: 0.5,
    repeatOk: true,
  });
  assert.ok(!("refused" in add), "the add is not refused as a repeat");
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

test("chain carries the stock price, or null when the broker has none", async () => {
  const { broker, engine } = setup();
  const before = await engine.chainFor({ underlying: "nvda", right: "call" });
  assert.equal(before.underlyingPrice, null);
  broker.stocks.set("NVDA", 238.4);
  const after = await engine.chainFor({ underlying: "nvda", right: "call" });
  assert.equal(after.underlyingPrice, 238.4);
  broker.stockPrice = async () => {
    throw new Error("data API down");
  };
  const down = await engine.chainFor({ underlying: "nvda", right: "call" });
  assert.equal(down.underlyingPrice, null);
  assert.ok(down.quotes.length > 0);
});

test("chain: today's volume and the last 30 minutes, null before the session trades", async () => {
  const { broker, engine } = setup();
  let asked: { symbols: string[]; end: number } | null = null;
  broker.optionVolume30 = async (symbols, end) => {
    asked = { symbols, end };
    return new Map([[near, 120]]);
  };
  // Before any trade today (the daily bar is Friday's): no volumes at all.
  broker.setVolume(near, 900, "2026-10-09");
  const before = await engine.chainFor({ underlying: "nvda", right: "call" });
  assert.deepEqual(
    before.quotes.map((x) => [x.volume, x.volume30]),
    [[null, null]],
  );
  assert.equal(asked, null);
  // Traded today: today's bar, and the 30 minutes up to now (11:00 New York).
  broker.setVolume(near, 340, "2026-10-12");
  const after = await engine.chainFor({ underlying: "nvda", right: "call" });
  assert.equal(after.minVolume30, 200);
  assert.deepEqual(
    after.quotes.map((x) => [x.contract, x.volume, x.volume30]),
    [[near, 340, 120]],
  );
  assert.deepEqual(asked, { symbols: [near], end: monday });
  // Without the minute bars the chain still comes back, today's volume kept.
  broker.optionVolume30 = async () => {
    throw new Error("bars down");
  };
  const down = await engine.chainFor({ underlying: "nvda", right: "call" });
  assert.deepEqual(
    down.quotes.map((x) => [x.volume, x.volume30]),
    [[340, null]],
  );
});

// The ticket's order types and the automatic stop as a choice (user
// 2026-10-18); option-tickets.ts.

test("option ticket: each type needs its prices, on the tick", () => {
  assert.deepEqual(optionTicket({}), { timeInForce: "day", noStop: false });
  assert.deepEqual(optionTicket({ limitPrice: 1.05 }), {
    type: "limit",
    limitPrice: 1.05,
    timeInForce: "day",
    noStop: false,
  });
  assert.deepEqual(
    optionTicket({
      orderType: "stop_limit",
      stopPrice: 1.1,
      limitPrice: 1.15,
      timeInForce: "gtc",
      autoStop: false,
    }),
    {
      type: "stop_limit",
      limitPrice: 1.15,
      stopPrice: 1.1,
      timeInForce: "gtc",
      noStop: true,
    },
  );
  assert.throws(() => optionTicket({ orderType: "stop" }), /needs stopPrice/);
  assert.throws(
    () => optionTicket({ orderType: "market", limitPrice: 1 }),
    /not used by a market order/,
  );
  assert.throws(
    () => optionTicket({ orderType: "limit", limitPrice: 3.12 }),
    /steps of 0.01 below \$3 and 0.05/,
  );
  assert.throws(
    () => optionTicket({ timeInForce: "gtc" }),
    /stepped buy is a day order/,
  );
  assert.throws(
    () => optionTicket({ orderType: "trailing_stop" }),
    /orderType must be/,
  );
});

test("engine buy at the market: one order, filled at the ask, stop kept", async () => {
  const { broker, engine } = setup();
  const out = await engine.buy({
    contract: friday,
    qty: 2,
    orderType: "market",
  });
  assert.ok("result" in out);
  assert.equal(out.result.order!.filledQty, 2);
  assert.equal(out.result.order!.filledAvgPrice, 1.04);
  assert.equal(out.stop?.price, stopPrice(1.04, 40));
  assert.deepEqual(
    [...broker.orders.values()].map((o) => o.kind),
    ["buy", "stop"],
  );
});

test("engine stop buy, GTC, no auto stop: left at the broker, not watched", async () => {
  const { broker, engine } = setup();
  const out = await engine.buy({
    contract: friday,
    qty: 2,
    orderType: "stop",
    stopPrice: 1.3,
    timeInForce: "gtc",
    autoStop: false,
  });
  assert.ok("result" in out);
  assert.equal(out.working, true);
  assert.equal(out.noStop, true);
  const [open] = await broker.openOrders(friday);
  assert.deepEqual(
    [open!.side, open!.type, open!.stopPrice, open!.timeInForce],
    ["buy", "stop", 1.3, "gtc"],
  );
  // It triggers later; nothing places a stop on it.
  broker.setQuote(friday, 1.3, 1.34, 0.2);
  assert.equal((await broker.order(open!.id)).status, "filled");
  assert.equal((await broker.openOrders(friday)).length, 0);
});

test("engine stepped buy without a stop: fills, no stop placed", async () => {
  const { broker, engine } = setup();
  const out = await engine.buy({ contract: friday, qty: 2, autoStop: false });
  assert.ok("result" in out);
  assert.equal(out.result.order!.filledQty, 2);
  assert.equal(out.stop?.price, undefined);
  assert.equal((await broker.openOrders(friday)).length, 0);
});

test("engine check: a stop limit is sized at its limit; no stop said plainly", async () => {
  const { broker, engine } = setup();
  const c = await engine.checkContract({
    contract: friday,
    qty: 2,
    orderType: "stop_limit",
    stopPrice: 1.1,
    limitPrice: 1.15,
    timeInForce: "gtc",
    autoStop: false,
  });
  assert.equal(c.ceiling, 1.15);
  assert.equal(c.maxCost, 230);
  assert.deepEqual(
    [c.orderType, c.stopPrice, c.limitPrice, c.timeInForce, c.autoStop],
    ["stop_limit", 1.1, 1.15, "gtc", false],
  );
  assert.equal(c.stopAtCeiling, null);
  assert.ok(c.notes.some((n) => n.startsWith("no automatic stop")));
  // A stop buy is counted at the stop or the ask, whichever is higher.
  const s = await engine.checkContract({
    contract: friday,
    qty: 1,
    orderType: "stop",
    stopPrice: 1.2,
  });
  assert.equal(s.ceiling, 1.2);
  assert.equal(broker.orders.size, 0);
});

test("engine: adding without a stop to a contract held with one is refused", async () => {
  const { engine, clock } = setup();
  await engine.buy({ contract: friday, qty: 1 });
  clock.now += 60 * 60_000; // past the repeat check
  const out = await engine.buy({
    contract: friday,
    qty: 1,
    orderType: "limit",
    limitPrice: 0.9,
    autoStop: false,
  });
  assert.ok("refused" in out);
  assert.match(out.refused[0]!, /adding without a stop/);
});
