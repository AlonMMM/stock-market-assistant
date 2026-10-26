import assert from "node:assert/strict";
import test from "node:test";
import { TraderService } from "../apps/trader/src/service.js";
import { TradeStore } from "../apps/trader/src/store.js";
import { handleOrderDecisions } from "../packages/trading/src/decisions-api.js";
import { TradeEngine } from "../packages/trading/src/engine.js";
import { NoNotifier } from "../packages/trading/src/notifier.js";
import { SimBroker } from "../packages/trading/src/sim-broker.js";

// Synthetic contracts and quotes; the broker is simulated in memory.
const monday = Date.parse("2026-10-12T15:00:00Z");
const strike = (k: number) => `NVDA261016C00${k}000`;

function setup() {
  const store = new TradeStore(":memory:");
  const broker = new SimBroker();
  const chain: [number, number, number, number][] = [
    [230, 2.4, 2.46, 0.31],
    [235, 1.5, 1.55, 0.2],
    [240, 1.0, 1.04, 0.12],
    [245, 0.6, 0.63, 0.07],
    [250, 0.3, 0.32, 0.03],
  ];
  for (const [k, bid, ask, delta] of chain)
    broker.setQuote(strike(k), bid, ask, delta, monday - 1000);
  broker.fillAt.set(strike(240), 1.03);
  broker.fillAt.set(strike(235), 1.54);
  const clock = { now: monday };
  const notifier = new NoNotifier();
  const engine = new TradeEngine({
    broker,
    notifier,
    posts: store.posts("owner"),
    buys: store.buys("owner"),
    decisions: store.decisions("owner"),
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
  return { service, broker, clock };
}

test("explanation: a buy records what was asked, what was default, and how it was sized", async () => {
  const { service } = setup();
  await service.buy({ underlying: "NVDA", right: "call", sizePct: 0.5 });
  await service.idle();
  const [d] = service.decisions().decisions;
  assert.ok(d);
  assert.equal(d.outcome, "filled");
  assert.equal(d.symbol, strike(240));
  const e = d.explanation;
  assert.deepEqual(
    e.inputs.map((i) => [i.name, i.value, i.source]),
    [
      ["Stock", "NVDA", "command"],
      ["Direction", "Call", "command"],
      ["Expiry", "nearest → 2026-10-16", "default"],
      ["Delta", "0.10–0.15", "default"],
      ["Size", "0.5% of the account", "command"],
      ["Stop", "40% of the premium", "default"],
    ],
  );
  assert.deepEqual(
    e.selection!.strikes.map((s) => [s.strike, s.chosen]),
    [
      [230, false],
      [235, false],
      [240, true],
      [245, false],
      [250, false],
    ],
  );
  assert.match(
    e.selection!.strikeRule,
    /closest to the middle of 0\.10–0\.15 \(0\.125\)/,
  );
  assert.deepEqual(
    [e.pricing.bid, e.pricing.ask, e.pricing.mid, e.pricing.ceiling],
    [1, 1.04, 1.02, 1.03],
  );
  assert.deepEqual(
    [e.sizing.budget, e.sizing.qty, e.sizing.maxCost],
    [500, 4, 412],
  );
  assert.match(
    e.sizing.rule,
    /0\.5% of 100,000 is 500\. One contract costs at most 1\.03 × 100 = 103, so 4 whole contracts fit \(412\)/,
  );
  assert.equal(e.stop.atCeiling, 0.62);
  assert.deepEqual(
    [e.risk.state, e.risk.daysToExpiry, e.risk.sharePct, e.risk.tradeRisk],
    // Counted at the order's 40% stop (2026-10-26), not 80% by days to expiry.
    ["full", 4, 40, 164.8],
  );
  assert.equal(e.checks.length, 17);
  assert.ok(e.checks.every((c) => c.ok));
  assert.deepEqual(d.result, {
    filledQty: 4,
    avgPrice: 1.03,
    stopPrice: 0.62,
    stopQty: 4,
  });
});

test("explanation: values from the command are marked, and a refused buy is kept with its reasons", async () => {
  const { service, clock } = setup();
  const out = await service.buy({
    underlying: "NVDA",
    right: "call",
    sizePct: 5,
    expiry: "friday",
    delta: 0.2,
    stopPct: 30,
  });
  assert.equal(out.status, "refused");
  const [d] = service.decisions().decisions;
  assert.ok(d);
  assert.equal(d.outcome, "refused");
  assert.equal(d.symbol, strike(235));
  assert.deepEqual(
    d.explanation.inputs.map((i) => [i.name, i.value, i.source]).slice(2),
    [
      ["Expiry", "friday → 2026-10-16", "command"],
      ["Delta", "closest to 0.2", "command"],
      ["Size", "5% of the account", "command"],
      ["Stop", "30% of the premium", "command"],
    ],
  );
  assert.deepEqual(d.explanation.refused, [
    "size: size 5% is outside 0–3% of the account",
  ]);
  assert.equal(d.result, undefined);
  // Newest first; an exact contract has no selection part.
  clock.now += 60_000;
  await service.buy({ contract: strike(235), sizePct: 0.5 });
  await service.idle();
  const all = service.decisions().decisions;
  assert.deepEqual(
    all.map((x) => x.outcome),
    ["filled", "refused"],
  );
  assert.equal(all[0]!.explanation.selection, undefined);
  assert.equal(all[0]!.explanation.inputs[0]!.name, "Contract");
});

test("explanation: the website reads them with the read-only token, or says why not", async () => {
  assert.equal((await handleOrderDecisions({})).status, 503);
  const seen: { url: string; auth: string | null }[] = [];
  const fetcher = (async (input: URL, init: RequestInit) => {
    seen.push({
      url: String(input),
      auth: new Headers(init.headers).get("Authorization"),
    });
    return Response.json({ decisions: [] });
  }) as unknown as typeof fetch;
  const ok = await handleOrderDecisions(
    { url: "https://trader.test", token: "read-token" },
    fetcher,
  );
  assert.deepEqual(ok, { status: 200, body: { decisions: [] } });
  assert.deepEqual(seen, [
    {
      url: "https://trader.test/v1/decisions?limit=100",
      auth: "Bearer read-token",
    },
  ]);
  const down = await handleOrderDecisions(
    { url: "https://trader.test", token: "t" },
    (async () => {
      throw new Error("no route");
    }) as unknown as typeof fetch,
  );
  assert.equal(down.status, 502);
});
