import assert from "node:assert/strict";
import test from "node:test";
import { RequestError, TraderService } from "../apps/trader/src/service.js";
import { TradeStore } from "../apps/trader/src/store.js";
import { TradeEngine } from "../packages/trading/src/engine.js";
import { TelegramNotifier } from "../packages/trading/src/notifier.js";
import { SimBroker } from "../packages/trading/src/sim-broker.js";

// Synthetic contracts and quotes; the broker is simulated in memory.
const friday = "NVDA261016C00240000";
const monday = Date.parse("2026-10-12T15:00:00Z");

function setup(store = new TradeStore(":memory:"), broker = new SimBroker()) {
  if (broker.orders.size === 0) {
    broker.setQuote(friday, 1.0, 1.04, 0.12);
    broker.fillAt.set(friday, 1.03);
  }
  const sent: string[] = [];
  const notifier = new TelegramNotifier({
    send: async (html) => {
      sent.push(html);
      return { ok: true, messageId: 100 + sent.length };
    },
  });
  const clock = { now: monday };
  const engine = new TradeEngine({
    broker,
    notifier,
    posts: store.posts("owner"),
    buys: store.buys("owner"),
    now: () => clock.now,
    sleep: async () => {},
  });
  const service = new TraderService({
    userId: "owner",
    store,
    engine,
    broker,
    notifier,
    now: () => clock.now,
  });
  return { store, broker, service, sent, clock };
}
const buyNvda = { underlying: "NVDA", right: "call", sizePct: 0.5 };

test("service buy: answers at once with a job; the job ends with the fill and stop", async () => {
  const { service, sent } = setup();
  const started = await service.buy(buyNvda);
  assert.equal(started.status, "started");
  assert.ok("jobId" in started);
  assert.deepEqual([started.contract, started.qty], [friday, 4]);
  await service.idle();
  const job = service.job(started.jobId);
  assert.equal(job.state, "done");
  const result = job.result as {
    stop: { qty: number };
    shortRisks: string[];
    post: { ok: boolean };
  };
  assert.equal(result.stop.qty, 4);
  assert.deepEqual(result.shortRisks, []);
  assert.equal(result.post.ok, true);
  assert.equal(sent.length, 1);
  const status = await service.status();
  assert.equal(status.limits.buysToday, 1);
  assert.equal(status.positions[0]!.stopQty, 4);
  assert.equal(status.limits.riskManager.state, "full");
});

test("manual strike works without delta on same-day option", async () => {
  const contract = "META261012C00765000";
  const broker = new SimBroker();
  broker.setQuote(contract, 1.0, 1.04, null);
  broker.fillAt.set(contract, 1.03);
  const { service } = setup(undefined, broker);
  const request = {
    underlying: "META",
    right: "call",
    strike: 765,
    expiry: "2026-10-12",
    sizePct: 0.5,
  };
  const preview = await service.preview(request);
  const row = preview.rows.find((item) => item.expiry === "2026-10-12");
  assert.ok(row);
  if ("error" in row) assert.fail(row.error);
  assert.deepEqual(
    [row.contract, row.strike, row.delta, row.wouldBuy],
    [contract, 765, null, true],
  );

  const started = await service.buy(request);
  assert.equal(started.status, "started");
  assert.equal(started.contract, contract);
  await service.idle();
  assert.equal(service.job(started.jobId).state, "done");
  assert.equal((await broker.position(contract)).qty, started.qty);
});

test("missing strike returns a client error without sending", async () => {
  const { service, broker } = setup();
  await assert.rejects(
    service.buy({
      underlying: "NVDA",
      right: "call",
      strike: 765,
      expiry: "2026-10-12",
      sizePct: 0.5,
    }),
    (error) =>
      error instanceof RequestError &&
      /No contract at strike 765/.test(error.message),
  );
  assert.equal(broker.orders.size, 0);
});

test("service buy: a refused buy creates no job and is logged", async () => {
  const { service, store, broker } = setup();
  const out = await service.buy({ ...buyNvda, sizePct: 5 });
  assert.equal(out.status, "refused");
  assert.ok("refused" in out);
  assert.match(out.refused.join(), /size: size 5% is outside 0–3%/);
  assert.equal(store.runningJobs().length, 0);
  assert.equal(broker.orders.size, 0);
  assert.match(store.recentLog()[0]!.outcome, /^refused: size: size 5%/);
});

test("service: bad requests are refused before anything else", async () => {
  const { service, broker } = setup();
  const bad = (body: Record<string, unknown>, text: RegExp) =>
    assert.rejects(
      service.buy(body),
      (e) => e instanceof RequestError && text.test(e.message),
    );
  await bad({ right: "call", sizePct: 0.5 }, /Need underlying and right/);
  await bad(
    { underlying: "NVDA; DROP", right: "call", sizePct: 0.5 },
    /underlying is not valid/,
  );
  await bad(
    { underlying: "NVDA", right: "both", sizePct: 0.5 },
    /right is not valid/,
  );
  await bad(
    { underlying: "NVDA", right: "call", sizePct: "0.5" },
    /sizePct must be a number/,
  );
  await bad(
    { underlying: "NVDA", right: "call", sizePct: 0.5, expiry: "soon" },
    /expiry is not valid/,
  );
  await bad(
    { underlying: "NVDA", right: "call", sizePct: 0.5, strike: 0 },
    /strike must be greater than zero/,
  );
  await bad(
    {
      underlying: "NVDA",
      right: "call",
      sizePct: 0.5,
      strike: 765,
      delta: 0.12,
    },
    /strike and delta cannot be combined/,
  );
  await assert.rejects(
    service.sell({ underlying: "NVDA", qty: "all" }),
    /No option position in NVDA/,
  );
  assert.throws(() => service.job("nope"), /No such job/);
  assert.equal(broker.orders.size, 0);
});

test("service sell and stop: a sale runs as a job, its exit under the entry post", async () => {
  const { service, broker, sent } = setup();
  await service.buy(buyNvda);
  await service.idle();
  await assert.rejects(
    service.sell({ underlying: "NVDA", qty: "9" }),
    /whole number from 1 to 4/,
  );
  const covered = await service.stop({ underlying: "NVDA" });
  assert.ok("note" in covered);
  broker.setQuote(friday, 1.5, 1.54, 0.2);
  const started = await service.sell({ underlying: "NVDA", qty: "half" });
  assert.deepEqual([started.selling, started.held], [2, 4]);
  await assert.rejects(
    service.sell({ underlying: "NVDA", qty: "all" }),
    (e) => e instanceof RequestError && e.status === 409,
  );
  await service.idle();
  const result = service.job(started.jobId).result as {
    result: { sold: number; remaining: number };
  };
  assert.deepEqual([result.result.sold, result.result.remaining], [2, 2]);
  assert.match(sent[1]!, /Sold 2 of 4 at 1\.50/);
});

test("service restart during a buy: the open order is canceled and the fill gets a stop", async () => {
  const store = new TradeStore(":memory:");
  const broker = new SimBroker();
  broker.setQuote(friday, 1.0, 1.04, 0.12);
  // The first service dies after 3 of 4 filled and before any stop.
  await broker.buyLimit(friday, 3, 1.03);
  broker.setQuote(friday, 1.0, 1.02, 0.12); // a seller came down for those 3
  await broker.buyLimit(friday, 1, 1.0);
  store.createJob(
    {
      id: "cut",
      userId: "owner",
      kind: "buy",
      symbol: friday,
      request: { stopPct: 40 },
    },
    monday,
  );
  assert.equal((await broker.openOrders(friday)).length, 1);
  const { service, sent } = setup(store, broker);
  assert.equal(await service.reconcile(), 1);
  const job = service.job("cut");
  assert.equal(job.state, "interrupted");
  const open = await broker.openOrders(friday);
  assert.deepEqual(
    open.map((o) => [o.side, o.qty, o.stopPrice]),
    [["sell", 3, 0.62]],
  );
  assert.match(sent[0]!, /Trading service restarted during a buy/);
  assert.match(sent[0]!, /3 held, stop placed at 0\.62 on 3/);
  // A second start finds nothing to settle.
  assert.equal(await service.reconcile(), 0);
});

test("service restart during a sale: its order is canceled, the stop goes back", async () => {
  const { service, store, broker } = setup();
  await service.buy(buyNvda);
  await service.idle();
  const stop = (await broker.openOrders(friday))[0]!;
  await broker.cancel(stop.id); // the sale had taken the stop off…
  await broker.sellLimit(friday, 4, 1.2); // …and was working above the bid
  store.createJob(
    { id: "cut", userId: "owner", kind: "sell", symbol: friday, request: {} },
    monday,
  );
  await service.reconcile();
  const open = await broker.openOrders(friday);
  assert.deepEqual(
    open.map((o) => [o.qty, o.stopPrice !== null]),
    [[4, true]],
  );
});

test("service off hours: the order waits at the broker and can be canceled", async () => {
  const store = new TradeStore(":memory:");
  const broker = new SimBroker();
  broker.setQuote(friday, 1.0, 1.04, 0.12);
  broker.fillAt.set(friday, 5); // nobody sells while the market is closed
  broker.isOpen = false;
  const sent: string[] = [];
  const notifier = new TelegramNotifier({
    send: async (html) => {
      sent.push(html);
      return { ok: true, messageId: 1 };
    },
  });
  // Each sleep hands control back, so the test can act while the job waits.
  let release: (() => void) | undefined;
  const sleep = () => new Promise<void>((r) => (release = r));
  const engine = new TradeEngine({
    broker,
    notifier,
    posts: store.posts("owner"),
    buys: store.buys("owner"),
    now: () => monday,
    sleep,
  });
  const service = new TraderService({
    userId: "owner",
    store,
    engine,
    broker,
    notifier,
    now: () => monday,
  });
  const started = await service.buy(buyNvda);
  assert.ok("jobId" in started);
  assert.equal(started.offHours, true);
  assert.match(started.notes.join(), /off hours: the market is closed/);
  while (!release) await new Promise((r) => setImmediate(r));
  const waiting = service.job(started.jobId);
  assert.deepEqual(
    [waiting.state, waiting.stage],
    ["running", "waiting for the market to open"],
  );
  assert.equal((await broker.openOrders(friday)).length, 1);
  assert.match(sent[0]!, /Off-hours order \(paper\)/);
  assert.match(sent[0]!, /The market is closed/);
  // The waiting order is listed, and is canceled by its stock alone.
  const status = await service.status();
  assert.deepEqual(
    status.workingOrders.map((o) => [o.contract, o.stage]),
    [[friday, "waiting for the market to open"]],
  );
  assert.deepEqual(
    status.openOrders.map((o) => [o.side, o.type, o.qty]),
    [["buy", "limit", 4]],
  );
  await assert.rejects(
    service.cancel({}),
    /Need jobId, underlying or contract/,
  );
  await assert.rejects(
    service.cancel({ underlying: "AMD" }),
    /No waiting or working buy order/,
  );
  const canceled = await service.cancel({ underlying: "nvda" });
  assert.deepEqual(canceled.canceled, [`4 ${friday}`]);
  assert.deepEqual(canceled.jobIds, [started.jobId]);
  release();
  await service.idle();
  const done = service.job(started.jobId);
  assert.equal(done.state, "done");
  assert.equal((done.result as { canceledQty: number }).canceledQty, 4);
  assert.equal((await broker.openOrders()).length, 0);
  // It bought nothing, so it does not use up one of the day's buys.
  assert.equal((await service.status()).limits.buysToday, 0);
  await assert.rejects(
    service.cancel({ jobId: started.jobId }),
    /already done/,
  );
  // An open buy order no job owns (after a restart) is withdrawn too; a stop is not.
  await broker.buyLimit(friday, 1, 1.0);
  assert.deepEqual((await service.cancel({ underlying: "NVDA" })).canceled, [
    `1 ${friday}`,
  ]);
  assert.equal((await broker.openOrders()).length, 0);
});

test("service: the ticket's order is checked before anything is sent", async () => {
  const { service, broker } = setup();
  for (const [body, error] of [
    [{ orderType: "stop" }, /needs stopPrice/],
    [{ orderType: "limit", limitPrice: 3.12 }, /steps of 0.01/],
    [{ timeInForce: "gtc" }, /stepped buy is a day order/],
    [{ autoStop: "no" }, /autoStop must be true or false/],
  ] as const)
    await assert.rejects(
      service.buy({ contract: friday, qty: 1, ...body }),
      error,
    );
  assert.equal(broker.orders.size, 0);
  const check = await service.check({
    contract: friday,
    qty: 1,
    orderType: "market",
    autoStop: false,
  });
  assert.equal(check.orderType, "market");
  assert.equal(check.autoStop, false);
});
