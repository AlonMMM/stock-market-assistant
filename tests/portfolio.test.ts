import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../apps/api/src/app.js";
import worker from "../apps/api/src/worker.js";
import {
  closedTrades,
  handlePortfolio,
  handlePortfolioHistory,
  PortfolioCache,
  type PortfolioHistory,
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
  assert.deepEqual(body.shortRisks, []);
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

test("portfolio: sell orders for more than is held are flagged", async () => {
  const { fetcher } = fake([
    order({ qty: "3" }),
    order({ id: "o2", qty: "2" }),
  ]);
  const body = (await handlePortfolio(keys, false, fetcher, now))
    .body as Portfolio;
  assert.deepEqual(body.shortRisks, [
    "OVERSOLD AMD261016C00660000: open sell orders for 5, 3 held",
  ]);
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

// Synthetic fills in Alpaca's activity shape.
const fill = (
  symbol: string,
  side: string,
  qty: number,
  price: number,
  time: string,
) => ({
  id: `${time}::${symbol}${side}`,
  activity_type: "FILL",
  symbol,
  side,
  qty: String(qty),
  price: String(price),
  transaction_time: time,
});
const amd = "AMD261016C00660000";
const nvda = "NVDA261009P00217500";
const activities = [
  fill(amd, "buy", 2, 1.6, "2026-10-05T14:00:00Z"),
  fill(amd, "buy", 1, 1.9, "2026-10-05T14:05:00Z"),
  fill(amd, "sell", 1, 2.5, "2026-10-06T15:00:00Z"),
  fill(amd, "sell", 2, 1.0, "2026-10-07T15:00:00Z"),
  fill(nvda, "buy", 4, 0.5, "2026-10-08T14:00:00Z"),
  {
    id: "exp",
    activity_type: "OPEXP",
    symbol: nvda,
    qty: "4",
    date: "2026-10-09",
  },
  fill("SPY", "sell", 5, 700, "2026-10-08T15:00:00Z"), // its buy is older
  fill("TSLA", "buy", 3, 400, "2026-10-09T15:00:00Z"), // still open
];

test("history: fills pair into closed trades, expiry closes at zero", () => {
  const trades = closedTrades([...activities].reverse());
  assert.deepEqual(
    trades.map((t) => [t.symbol, t.qty, t.entry, t.exit, t.pnl, t.expired]),
    [
      // 4 × 0.50 × 100 lost in full.
      [nvda, 4, 0.5, 0, -200, true],
      // Bought 3 for 5.10, sold for 4.50: (4.50 − 5.10) × 100 = −60.
      [amd, 3, 1.7, 1.5, -60, false],
    ],
  );
  assert.equal(trades[0]!.pnlPct, -100);
  assert.equal(trades[1]!.openedAt, "2026-10-05T14:00:00Z");
  assert.equal(trades[1]!.closedAt, "2026-10-07T15:00:00Z");
});

test("history: daily profit and loss with the period's closed trades", async () => {
  const seen: string[] = [];
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    seen.push(url.pathname + url.search);
    return Response.json(
      url.pathname.endsWith("/history")
        ? {
            timestamp: [1791244800, 1791331200, 1791417600],
            equity: [100000, 100150, null],
            profit_loss: [0, 150, null],
            base_value: 100000,
          }
        : activities,
    );
  }) as typeof fetch;
  const cache = new PortfolioCache();
  const at = Date.parse("2026-10-10T09:00:00Z");
  const result = await handlePortfolioHistory(
    keys,
    "1W",
    false,
    fetcher,
    at,
    cache,
  );
  assert.equal(result.status, 200);
  const body = result.body as PortfolioHistory;
  assert.deepEqual(body.points, [
    { date: "2026-10-05", equity: 100000, pnl: 0 },
    { date: "2026-10-06", equity: 100150, pnl: 150 },
  ]);
  assert.equal(body.pnl, 150);
  assert.equal(body.pnlPct, 0.15);
  assert.equal(body.trades.length, 2);
  assert.equal(body.realized, -260);
  assert.equal(body.wins, 0);
  assert.equal(body.truncated, false);
  assert.match(seen[0]!, /portfolio\/history\?period=1W&timeframe=1D/);
  // Reused within a minute; a bad period is refused before any request.
  await handlePortfolioHistory(keys, "1W", false, fetcher, at + 30000, cache);
  assert.equal(seen.length, 2);
  assert.equal(
    (await handlePortfolioHistory(keys, "5Y", false, fetcher)).status,
    400,
  );
  assert.equal(seen.length, 2);
  const app = buildApp(false, { ...keys, fetcher });
  const local = await app.inject({
    method: "GET",
    url: "/api/portfolio/history?period=1M",
  });
  assert.equal(local.statusCode, 200);
  assert.equal((local.json() as PortfolioHistory).period, "1M");
  await app.close();
  assert.equal(
    (
      await worker.fetch(
        new Request("https://example.test/api/portfolio/history"),
        {},
      )
    ).status,
    503,
  );
});
