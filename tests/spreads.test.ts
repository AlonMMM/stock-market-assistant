import assert from "node:assert/strict";
import test from "node:test";
import {
  AlpacaTrading,
  paperUrl,
} from "../packages/trading/src/alpaca-trading.js";
import { RequestError, TraderService } from "../apps/trader/src/service.js";
import { TradeStore } from "../apps/trader/src/store.js";
import { handleControl } from "../packages/trading/src/control-api.js";
import { openRisk, withoutStop } from "../packages/trading/src/checks.js";
import {
  MemoryBuyLog,
  MemoryPostStore,
  TradeEngine,
  TradeRefusal,
} from "../packages/trading/src/engine.js";
import { NoNotifier } from "../packages/trading/src/notifier.js";
import {
  covers,
  shortRisks,
  spreadPairs,
} from "../packages/trading/src/safety.js";
import { SimBroker } from "../packages/trading/src/sim-broker.js";

// Synthetic contracts and quotes; the broker is simulated in memory.
const c240 = "NVDA261016C00240000";
const c245 = "NVDA261016C00245000";
const c250 = "NVDA261016C00250000";
const p230 = "NVDA261016P00230000";
const p225 = "NVDA261016P00225000";
const later = "NVDA261023C00245000";
const monday = Date.parse("2026-10-12T15:00:00Z");

function setup() {
  const broker = new SimBroker(100_000);
  broker.setQuote(c240, 1.0, 1.04, 0.3);
  broker.setQuote(c245, 0.4, 0.44, 0.15);
  broker.setQuote(c250, 0.1, 0.12, 0.05);
  broker.setQuote(later, 0.9, 0.95, 0.2);
  const engine = new TradeEngine({
    broker,
    notifier: new NoNotifier(),
    posts: new MemoryPostStore(),
    buys: new MemoryBuyLog(),
    now: () => monday,
    sleep: async () => {},
  });
  return { broker, engine };
}

test("a long leg covers a short one only as a debit vertical", () => {
  assert.equal(covers(c240, c245), true); // call: long strike below
  assert.equal(covers(c245, c240), false); // a credit call spread
  assert.equal(covers(p230, p225), true); // put: long strike above
  assert.equal(covers(p225, p230), false);
  assert.equal(covers(c240, later), false); // another expiry
  assert.equal(covers(c240, p225), false); // another right
  assert.equal(covers("NVDA", c245), false); // shares cover no option
});

test("never short: a covered short leg is fine, a bare one is not", () => {
  assert.deepEqual(
    shortRisks(
      [
        { symbol: c240, qty: 2 },
        { symbol: c245, qty: -2 },
      ],
      [],
    ),
    [],
  );
  assert.deepEqual(
    shortRisks(
      [
        { symbol: c240, qty: 1 },
        { symbol: c245, qty: -3 },
      ],
      [],
    ),
    [`SHORT ${c245}: 2 contracts sold short, 1 covered by a spread's long leg`],
  );
  // A credit spread's short leg is not covered.
  assert.deepEqual(
    shortRisks(
      [
        { symbol: c245, qty: 1 },
        { symbol: c240, qty: -1 },
      ],
      [],
    ),
    [`SHORT ${c240}: 1 contract sold short`],
  );
});

test("never short: a sell order on a spread's long leg is a risk", () => {
  const positions = [
    { symbol: c240, qty: 3 },
    { symbol: c245, qty: -2 },
  ];
  const sell = (qty: number) => ({
    symbol: c240,
    side: "sell",
    qty,
    filledQty: 0,
  });
  // One contract is outside the spread and may have its stop.
  assert.deepEqual(shortRisks(positions, [sell(1)]), []);
  assert.deepEqual(shortRisks(positions, [sell(2)]), [
    `OVERSOLD ${c240}: open sell orders for 2, 1 free; 2 cover a spread's short leg`,
  ]);
  // A multi-leg order is the broker's own covered unit.
  const mleg = { symbol: "", side: "", qty: 1, filledQty: 0, legs: [{}] };
  assert.deepEqual(shortRisks(positions, [mleg]), []);
});

test("a short leg takes the covering long nearest its strike", () => {
  assert.deepEqual(
    spreadPairs([
      { symbol: c240, qty: 1 },
      { symbol: c245, qty: 1 },
      { symbol: c250, qty: -1 },
    ]),
    [{ long: c245, short: c250, qty: 1 }],
  );
});

test("a spread needs no stop and counts its net debit as risk", () => {
  const held = (symbol: string, qty: number, avg: number, stopQty = 0) => ({
    symbol,
    qty,
    avgEntryPrice: avg,
    stopQty,
    stopPrice: stopQty > 0 ? avg / 2 : null,
  });
  const positions = [held(c240, 2, 1.0), held(c245, -2, 0.4)];
  assert.deepEqual(withoutStop(positions), []);
  // (1.00 − 0.40) × 2 × 100
  assert.equal(Math.round(openRisk(positions)), 120);
  // A third long contract outside the spread still needs its stop.
  const more = [held(c240, 3, 1.0), held(c245, -2, 0.4)];
  assert.deepEqual(
    withoutStop(more).map((p) => p.symbol),
    [c240],
  );
});

test("spread check: sized on the net debit, with its numbers", async () => {
  const { broker, engine } = setup();
  const c = await engine.checkSpreadOrder({
    long: c240,
    short: c245,
    sizePct: 0.5,
  });
  // Mid (1.02 − 0.42) = 0.60; $500 buys 8 at $60.
  assert.equal(c.limitPrice, 0.6);
  assert.equal(c.qty, 8);
  assert.equal(c.maxLoss, 480);
  assert.equal(c.maxGain, 3520);
  assert.equal(c.breakeven, 240.6);
  assert.equal(c.natural, 0.64);
  assert.equal(c.wouldBuy, true, c.refused.join("; "));
  assert.equal(broker.orders.size, 0);
});

test("spread check refuses a credit spread and a debit over the width", async () => {
  const { engine } = setup();
  const credit = await engine.checkSpreadOrder({
    long: c245,
    short: c240,
    qty: 1,
    limitPrice: 0.5,
  });
  assert.equal(credit.wouldBuy, false);
  assert.ok(credit.refused.some((r) => r.startsWith("legs: buying 245")));
  const wide = await engine.checkSpreadOrder({
    long: c240,
    short: c245,
    qty: 1,
    limitPrice: 5,
  });
  assert.ok(wide.refused.some((r) => r.startsWith("net debit:")));
  const mixed = await engine.checkSpreadOrder({
    long: c240,
    short: later,
    qty: 1,
  });
  assert.ok(mixed.refused.some((r) => r.startsWith("legs: both legs")));
});

test("a spread opens as one order, then one leg cannot be sold alone", async () => {
  const { broker, engine } = setup();
  const plan = await engine.planSpread({
    long: c240,
    short: c245,
    qty: 2,
    limitPrice: 0.64,
  });
  assert.ok(!("refused" in plan), JSON.stringify(plan));
  const done = await engine.runSpread(plan);
  assert.equal(done.order.status, "filled");
  assert.deepEqual(
    (await broker.positions()).map((p) => [p.symbol, p.qty]),
    [
      [c240, 2],
      [c245, -2],
    ],
  );
  assert.deepEqual((await engine.shortCheck()).problems, []);
  // The long leg gets no stop and is not sold alone.
  const stop = await engine.setStop({ contract: c240 });
  assert.ok("note" in stop && stop.note?.includes("spread") === true);
  await assert.rejects(
    engine.sell({ contract: c240, qty: "all" }),
    (e: unknown) => e instanceof TradeRefusal && e.check === "spread",
  );
  await assert.rejects(
    engine.moveStop({ contract: c240, price: 0.5 }),
    TradeRefusal,
  );
  // A later single buy is not blocked by the leg lacking a stop.
  const single = await engine.checkContract({ contract: c250, qty: 1 });
  assert.ok(
    single.checks.find((c) => c.check === "positions without a stop")?.ok,
  );
});

test("a held spread closes as one order for a net credit", async () => {
  const { broker, engine } = setup();
  const plan = await engine.planSpread({
    long: c240,
    short: c245,
    qty: 2,
    limitPrice: 0.64,
  });
  assert.ok(!("refused" in plan));
  await engine.runSpread(plan);
  const close = await engine.planClose({ long: c240, short: c245 });
  assert.equal(close.qty, 2);
  assert.equal(close.credit, 0.6);
  // The natural credit: sell at the bid 1.00, buy back at the ask 0.44.
  const done = await engine.closeSpread({ ...close, credit: 0.56 });
  assert.equal(done.order.status, "filled");
  assert.deepEqual(await broker.positions(), []);
  await assert.rejects(
    engine.planClose({ long: c240, short: c245 }),
    TradeRefusal,
  );
});

test("an own limit price buys at that price, with the stop on the fill", async () => {
  const { broker, engine } = setup();
  const check = await engine.checkContract({
    contract: c245,
    qty: 2,
    limitPrice: 0.44,
  });
  assert.equal(check.ceiling, 0.44);
  assert.equal(check.maxCost, 88);
  const plan = await engine.planBuy({
    contract: c245,
    qty: 2,
    limitPrice: 0.44,
  });
  assert.ok(!("refused" in plan));
  const done = await engine.runBuy(plan);
  assert.deepEqual(done.result.prices, [0.44]);
  assert.equal(done.result.order?.limitPrice, 0.44);
  assert.equal(done.result.order?.status, "filled");
  assert.equal(done.stop?.qty, 2);
  const buys = [...broker.orders.values()].filter((o) => o.kind === "buy");
  assert.equal(buys.length, 1);
});

test("site: spread requests are checked and forwarded", async () => {
  const seen: { url: string; body: unknown }[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const config = {
    owner: "owner@example.com",
    url: "https://trader.test",
    token: "t",
  };
  const origin = "https://site.test";
  const post = (path: string, body: unknown) =>
    handleControl(
      config,
      { email: "owner@example.com" },
      {
        method: "POST",
        path: `/api/portfolio/control/${path}`,
        body,
        origin,
        requestOrigin: origin,
      },
      fetcher,
    );
  const ok = await post("spread/buy", {
    long: c240,
    short: c245,
    sizePct: 0.5,
    limitPrice: 0.6,
    extra: "dropped",
  });
  assert.equal(ok.status, 200);
  assert.equal(seen[0]!.url, "https://trader.test/v1/spread/buy");
  assert.deepEqual(seen[0]!.body, {
    long: c240,
    short: c245,
    sizePct: 0.5,
    limitPrice: 0.6,
    via: "site",
  });
  assert.equal(
    (await post("spread/buy", { long: c240, short: c245 })).status,
    400,
  );
  assert.equal(
    (await post("spread/close", { long: c240, short: "x" })).status,
    400,
  );
  const close = await post("spread/close", { long: c240, short: c245 });
  assert.equal(close.status, 200);
  assert.equal(seen[1]!.url, "https://trader.test/v1/spread/close");
  assert.equal(
    (await post("buy", { contract: c240, qty: 1, limitPrice: -1 })).status,
    400,
  );
});

test("alpaca: a spread is one mleg order, read back with its legs", async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    const order = {
      id: "o1",
      symbol: "",
      side: "",
      status: "new",
      qty: "2",
      filled_qty: "0",
      filled_avg_price: null,
      limit_price: "0.6",
      stop_price: null,
      type: "limit",
      time_in_force: "day",
      order_class: "mleg",
      legs: [
        { symbol: c240, side: "buy", position_intent: "buy_to_open" },
        { symbol: c245, side: "sell", position_intent: "sell_to_open" },
      ],
    };
    return new Response(
      JSON.stringify(init.method === "POST" ? order : [order]),
      { status: 200 },
    );
  }) as typeof fetch;
  const alpaca = new AlpacaTrading("k", "s", paperUrl, "opra", fetcher);
  const sent = await alpaca.spreadOrder({
    legs: [
      { symbol: c240, side: "buy", intent: "buy_to_open" },
      { symbol: c245, side: "sell", intent: "sell_to_open" },
    ],
    qty: 2,
    limitPrice: 0.6,
  });
  assert.equal(sent.id, "o1");
  assert.deepEqual(calls[0]!.body, {
    order_class: "mleg",
    qty: "2",
    type: "limit",
    time_in_force: "day",
    limit_price: "0.60",
    legs: [
      {
        symbol: c240,
        ratio_qty: "1",
        side: "buy",
        position_intent: "buy_to_open",
      },
      {
        symbol: c245,
        ratio_qty: "1",
        side: "sell",
        position_intent: "sell_to_open",
      },
    ],
  });
  const [open] = await alpaca.openOrders();
  assert.ok(calls[1]!.url.includes("nested=true"));
  assert.deepEqual(open!.legs, [
    { symbol: c240, side: "buy", intent: "buy_to_open" },
    { symbol: c245, side: "sell", intent: "sell_to_open" },
  ]);
});

test("service: a spread runs as a job; one leg is not sold alone", async () => {
  const { broker, engine } = setup();
  const store = new TradeStore(":memory:");
  const service = new TraderService({
    userId: "owner",
    store,
    engine,
    broker,
    notifier: new NoNotifier(),
    now: () => monday,
  });
  const started = await service.spreadBuy({
    long: c240,
    short: c245,
    qty: 1,
    limitPrice: 0.64,
  });
  assert.equal(started.status, "started");
  await service.idle();
  const job = service.job("jobId" in started ? started.jobId : "");
  assert.equal(job.state, "done");
  assert.deepEqual((job.result as { shortRisks: string[] }).shortRisks, []);
  await assert.rejects(
    service.sell({ contract: c240, qty: "all" }),
    (e: unknown) =>
      e instanceof RequestError && e.message.includes("close the spread"),
  );
  await assert.rejects(
    service.spreadBuy({ long: c240, short: c240, qty: 1 }),
    RequestError,
  );
  const closing = await service.spreadClose({
    long: c240,
    short: c245,
    limitPrice: 0.56,
  });
  assert.equal(closing.status, "started");
  await service.idle();
  assert.deepEqual(await broker.positions(), []);
});
