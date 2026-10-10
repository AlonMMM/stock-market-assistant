import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../apps/api/src/app.js";
import worker from "../apps/api/src/worker.js";
import {
  handlePortfolio,
  PortfolioCache,
  type Portfolio,
} from "../packages/trading/src/portfolio.js";

// Synthetic account data in Alpaca's response shape.
const account = {
  equity: "100500",
  last_equity: "100000",
  cash: "98000",
  buying_power: "98000",
};
const positions = [
  {
    symbol: "AMD261016C00660000",
    asset_class: "us_option",
    qty: "3",
    avg_entry_price: "1.70",
    current_price: "2.10",
    market_value: "630",
    cost_basis: "510",
    unrealized_pl: "120",
    unrealized_plpc: "0.2353",
    unrealized_intraday_pl: "120",
  },
  {
    symbol: "SPY",
    asset_class: "us_equity",
    qty: "5",
    avg_entry_price: "700",
    current_price: "690",
    market_value: "3450",
    cost_basis: "3500",
    unrealized_pl: "-50",
    unrealized_plpc: "-0.0143",
    unrealized_intraday_pl: "-10",
  },
];
const order = (over: object) => ({
  id: "o1",
  symbol: "AMD261016C00660000",
  side: "sell",
  type: "stop",
  qty: "3",
  filled_qty: "0",
  limit_price: null,
  stop_price: "1.02",
  status: "new",
  submitted_at: "2026-10-12T14:00:00Z",
  ...over,
});

function fake(orders: object[], status = 200) {
  const seen: string[] = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
    const body =
      url.pathname === "/v2/account"
        ? account
        : url.pathname === "/v2/positions"
          ? positions
          : orders;
    return Response.json(body, { status });
  }) as typeof fetch;
  return { fetcher, seen };
}
const keys = { key: "k", secret: "s" };
const now = Date.parse("2026-10-12T15:00:00Z");

test("portfolio: account totals, positions with their stop, and orders", async () => {
  const { fetcher, seen } = fake([order({})]);
  const result = await handlePortfolio(keys, false, fetcher, now);
  assert.equal(result.status, 200);
  const body = result.body as Portfolio;
  assert.equal(body.paper, true);
  assert.deepEqual(body.account, {
    equity: 100500,
    cash: 98000,
    buyingPower: 98000,
    dayChange: 500,
    dayChangePct: 0.5,
  });
  // Largest position first.
  assert.deepEqual(
    body.positions.map((p) => p.symbol),
    ["SPY", "AMD261016C00660000"],
  );
  const amd = body.positions[1]!;
  assert.deepEqual(amd.option, {
    right: "call",
    strike: 660,
    expiry: "2026-10-16",
  });
  assert.equal(amd.pnlPct, 23.53);
  assert.equal(amd.sharePct, 0.63);
  // (1.70 − 1.02) × 3 contracts × 100 = 204 at risk: 40% of the premium.
  assert.deepEqual(amd.stop, { price: 1.02, qty: 3, lossPct: 40, risk: 204 });
  assert.equal(body.positions[0]!.stop, null);
  assert.equal(body.riskAtStops, 204);
  assert.equal(body.unprotected, 1); // SPY has no stop
  assert.equal(body.orders.length, 1);
  // Read-only, on the paper host.
  assert.ok(seen.every((s) => s.startsWith("GET paper-api.alpaca.markets/")));
  assert.equal(seen.length, 3);
});

test("portfolio: a stop covering part of a position leaves it unprotected", async () => {
  const { fetcher } = fake([order({ qty: "2" }), order({ side: "buy" })]);
  const body = (await handlePortfolio(keys, false, fetcher, now))
    .body as Portfolio;
  const amd = body.positions.find((p) => p.option)!;
  assert.equal(amd.stop?.qty, 2);
  assert.equal(amd.stop?.risk, 136);
  assert.equal(body.unprotected, 2);
});

test("portfolio: live account host, missing keys and refused keys", async () => {
  const live = fake([]);
  assert.equal(
    ((await handlePortfolio(keys, true, live.fetcher, now)).body as Portfolio)
      .paper,
    false,
  );
  assert.ok(live.seen.every((s) => s.startsWith("GET api.alpaca.markets/")));
  assert.equal((await handlePortfolio({}, false, live.fetcher)).status, 503);
  const refused = await handlePortfolio(keys, false, fake([], 403).fetcher);
  assert.equal(refused.status, 502);
  assert.match((refused.body as { error: string }).error, /paper account/);
});

test("portfolio: local API and Worker routes", async () => {
  const app = buildApp(false, { ...keys, fetcher: fake([order({})]).fetcher });
  const local = await app.inject({ method: "GET", url: "/api/portfolio" });
  assert.equal(local.statusCode, 200);
  assert.equal(local.headers["cache-control"], "no-store");
  assert.equal((local.json() as Portfolio).positions.length, 2);
  await app.close();
  const url = "https://example.test/api/portfolio";
  assert.equal((await worker.fetch(new Request(url), {})).status, 503);
  assert.equal(
    (await worker.fetch(new Request(url, { method: "POST" }), {})).status,
    405,
  );
});

test("portfolio: answers are reused, orders for longer, and errors are not kept", async () => {
  const { fetcher, seen } = fake([order({})]);
  const cache = new PortfolioCache();
  const at = (ms: number) =>
    handlePortfolio(keys, false, fetcher, now + ms, cache);
  await at(0);
  await at(500); // everything reused
  assert.equal(seen.length, 3);
  await at(1000); // account and positions again, orders reused
  assert.deepEqual(
    seen.slice(3).map((s) => s.split("/v2/")[1]),
    ["account", "positions"],
  );
  const later = await at(6000);
  assert.equal(seen.length, 8);
  assert.equal((later.body as Portfolio).at, "2026-10-12T15:00:06.000Z");
  // The paper and live accounts never share an answer.
  await handlePortfolio(keys, true, fetcher, now + 6000, cache);
  assert.equal(seen.length, 11);
  const failing = new PortfolioCache();
  const down = fake([], 500);
  assert.equal(
    (await handlePortfolio(keys, false, down.fetcher, now, failing)).status,
    502,
  );
  assert.equal(
    (await handlePortfolio(keys, false, fetcher, now, failing)).status,
    200,
  );
});
