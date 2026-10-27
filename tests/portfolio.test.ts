import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../apps/api/src/app.js";
import worker from "../apps/api/src/worker.js";
import {
  optionDeltaExposure,
  positionNumbers,
} from "../apps/web/src/positions-model.js";
import {
  closedTrades,
  tradeLots,
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
    symbol: "AMD261016C00720000",
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
  symbol: "AMD261016C00720000",
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

function fake(orders: object[], status = 200, isOpen = true) {
  const seen: string[] = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
    const body =
      url.pathname === "/v2/clock"
        ? { is_open: isOpen }
        : url.pathname === "/v2/account"
          ? account
          : url.pathname === "/v2/positions"
            ? positions
            : url.pathname === "/v1beta1/options/snapshots"
              ? {
                  snapshots: {
                    AMD261016C00720000: {
                      greeks: {
                        delta: 0.6,
                        gamma: 0.02,
                        theta: -0.1,
                        vega: 0.05,
                      },
                      implied_volatility: 0.35,
                      latestQuote: {
                        bp: 2,
                        ap: 2.2,
                        t: "2026-10-12T14:59:00Z",
                      },
                    },
                  },
                }
              : url.pathname === "/v2/stocks/snapshots"
                ? {
                    snapshots: {
                      AMD: {
                        latestTrade: { p: 700, t: "2026-10-12T15:00:00Z" },
                        dailyBar: { c: 690, t: "2026-10-12T04:00:00Z" },
                        prevDailyBar: { c: 680, t: "2026-10-09T04:00:00Z" },
                      },
                    },
                  }
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
    ["SPY", "AMD261016C00720000"],
  );
  const amd = body.positions[1]!;
  assert.deepEqual(amd.option, {
    right: "call",
    strike: 720,
    expiry: "2026-10-16",
  });
  assert.equal(amd.pnlPct, 23.53);
  assert.equal(amd.sharePct, 0.63);
  assert.equal(amd.underlyingPrice, 700);
  assert.equal(amd.delta, 0.6);
  // A one-minute-old mark at the live price: one minute of decay only.
  assert.equal(amd.estimatedPrice, 2.1);
  assert.equal(amd.estimateBreakdown?.underlyingReferenceSource, "live");
  // (1.70 − 1.02) × 3 contracts × 100 = 204 at risk: 40% of the premium.
  assert.deepEqual(amd.stop, { price: 1.02, qty: 3, lossPct: 40, risk: 204 });
  assert.equal(body.positions[0]!.stop, null);
  assert.equal(body.riskAtStops, 204);
  assert.equal(body.unprotected, 1); // SPY has no stop
  assert.deepEqual(body.shortRisks, []);
  assert.equal(body.orders.length, 1);
  // Read-only, on the paper host.
  assert.ok(seen.some((s) => s.startsWith("GET paper-api.alpaca.markets/")));
  assert.ok(seen.some((s) => s.startsWith("GET data.alpaca.markets/")));
  assert.equal(seen.length, 6);
});

test("portfolio: missing option data explains failed market-data requests", async () => {
  const { fetcher: accountFetcher } = fake([order({})]);
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    if (new URL(String(input)).host === "data.alpaca.markets")
      return Response.json({ message: "forbidden" }, { status: 403 });
    return accountFetcher(input, init);
  }) as typeof fetch;
  const result = await handlePortfolio(keys, false, fetcher, now);
  const body = result.body as Portfolio;
  const option = body.positions.find((p) => p.option)!;
  assert.match(option.marketDataIssue ?? "", /Options: .*HTTP 403/);
  assert.match(option.marketDataIssue ?? "", /Stocks: .*HTTP 403/);
});

test("portfolio: overnight underlying snapshots use Alpaca BOATS data", async () => {
  const { fetcher: baseFetcher } = fake([order({})]);
  let stockFeed: string | null = null;
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v2/stocks/snapshots") {
      const feed = url.searchParams.get("feed");
      if (feed) stockFeed = feed;
    }
    return baseFetcher(input, init);
  }) as typeof fetch;
  // 2026-10-13 22:00 in New York (Wednesday 02:00 in Israel).
  await handlePortfolio(
    keys,
    false,
    fetcher,
    Date.parse("2026-10-14T02:00:00Z"),
  );
  assert.equal(stockFeed, "boats");
});

test("portfolio: overnight option estimate falls back to the underlying quote", async () => {
  const { fetcher: baseFetcher } = fake([order({})]);
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const response = await baseFetcher(input, init);
    const url = new URL(String(input));
    if (url.pathname !== "/v2/stocks/snapshots") return response;
    const body = (await response.json()) as {
      snapshots: Record<
        string,
        {
          latestTrade?: unknown;
          latestQuote?: unknown;
          dailyBar?: unknown;
          prevDailyBar?: unknown;
        }
      >;
    };
    body.snapshots.AMD = {
      latestQuote: {
        bp: 703,
        ap: 705,
        t: "2026-10-14T02:00:00Z",
      },
      dailyBar: { c: 690, t: "2026-10-12T04:00:00Z" },
      prevDailyBar: { c: 680, t: "2026-10-09T04:00:00Z" },
    };
    return Response.json(body);
  }) as typeof fetch;
  const result = await handlePortfolio(
    keys,
    false,
    fetcher,
    Date.parse("2026-10-14T02:00:00Z"),
  );
  const body = result.body as Portfolio;
  const option = body.positions.find((p) => p.option)!;
  assert.equal(option.underlyingPrice, 704);
  assert.equal(option.underlyingPriceSource, "quote");
  assert.ok(option.estimatedPrice !== null);
  assert.equal(option.underlyingAsOf, "2026-10-14T02:00:00Z");
  assert.equal(option.marketDataIssue, null);
});

test("portfolio: overnight snapshots fall back to regular-feed close and keep Greeks", async () => {
  const { fetcher: baseFetcher } = fake([order({})], 200, false);
  let regularFeedRequested = false;
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v2/stocks/snapshots") {
      if (url.searchParams.get("feed") === "boats")
        return Response.json({ snapshots: {} });
      regularFeedRequested = true;
      const response = await baseFetcher(input, init);
      const body = (await response.json()) as {
        snapshots: Record<
          string,
          {
            latestTrade?: unknown;
            latestQuote?: unknown;
            dailyBar?: unknown;
            prevDailyBar?: unknown;
          }
        >;
      };
      body.snapshots.AMD = {
        dailyBar: { c: 690, t: "2026-10-12T04:00:00Z" },
        prevDailyBar: { c: 680, t: "2026-10-09T04:00:00Z" },
      };
      return Response.json(body);
    }
    return baseFetcher(input, init);
  }) as typeof fetch;
  const result = await handlePortfolio(
    keys,
    false,
    fetcher,
    Date.parse("2026-10-14T02:00:00Z"),
  );
  const body = result.body as Portfolio;
  const option = body.positions.find((p) => p.option)!;
  assert.equal(regularFeedRequested, true);
  assert.equal(option.underlyingPrice, 690);
  assert.equal(option.underlyingPriceSource, "close");
  assert.equal(option.delta, 0.6);
  assert.equal(option.gamma, 0.02);
  assert.equal(option.theta, -0.1);
  assert.equal(option.vega, 0.05);
  assert.equal(option.impliedVolatility, 0.35);
  assert.ok(option.estimatedPrice !== null);
  assert.equal(option.marketDataIssue, null);
});

test("portfolio: overnight Greeks calculate delta exposure and estimated option price from bars", async () => {
  const { fetcher: baseFetcher } = fake([order({})], 200, false);
  const requested: string[] = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    requested.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/v2/stocks/snapshots")
      return Response.json({ snapshots: {} });
    if (url.pathname === "/v2/stocks/bars/latest")
      return Response.json({
        bars: { AMD: { c: 705, t: "2026-10-13T23:59:00Z" } },
      });
    if (
      url.pathname === "/v2/stocks/bars" &&
      url.searchParams.get("timeframe") === "1Min"
    )
      // AMD at the option's 10:59 quote, and a minute later.
      return Response.json({
        bars: {
          AMD: [
            { c: 688, t: "2026-10-12T14:58:00Z" },
            { c: 690, t: "2026-10-12T14:59:00Z" },
            { c: 699, t: "2026-10-12T15:00:00Z" },
          ],
        },
      });
    if (url.pathname === "/v2/stocks/bars")
      return Response.json({
        bars: {
          AMD: [
            { c: 695, t: "2026-10-12T04:00:00Z" },
            { c: 680, t: "2026-10-09T04:00:00Z" },
          ],
        },
      });
    return baseFetcher(input, init);
  }) as typeof fetch;
  const result = await handlePortfolio(
    keys,
    false,
    fetcher,
    Date.parse("2026-10-14T02:00:00Z"),
  );
  const body = result.body as Portfolio;
  const option = body.positions.find((p) => p.option)!;
  const elapsedDays =
    (Date.parse("2026-10-14T02:00:00Z") - Date.parse("2026-10-12T14:59:00Z")) /
    86400000;
  assert.equal(option.underlyingPrice, 705);
  assert.equal(option.underlyingPriceSource, "bar");
  assert.equal(option.delta, 0.6);
  assert.ok(option.estimatedPrice !== null);
  // Black-Scholes at the IV implied by the 2.10 mark with AMD at 690 (the
  // minute bar of the quote, not the 695 daily close), repriced at 705 with
  // 1.46 fewer days to expiry.
  assert.equal(option.estimatedPrice, 3.6);
  const breakdown = option.estimateBreakdown!;
  assert.equal(breakdown.model, "black-scholes");
  assert.equal(breakdown.underlyingReference, 690);
  assert.equal(breakdown.underlyingReferenceSource, "minute");
  assert.equal(breakdown.underlyingMove, 15);
  assert.ok(Math.abs(breakdown.elapsedDays - elapsedDays) < 1e-9);
  assert.ok(breakdown.moveEffect > 0 && breakdown.timeEffect < 0);
  assert.ok(
    Math.abs(
      breakdown.optionMark +
        breakdown.moveEffect +
        breakdown.timeEffect -
        3.6006,
    ) < 1e-3,
  );
  assert.equal(
    optionDeltaExposure(option.qty, option.underlyingPrice, option.delta),
    126900,
  );
  assert.deepEqual(body.overnightEstimate, {
    equity: 100950,
    change: 450, // (3.60 − 2.10) × 3 contracts × 100

    pricedPositions: 1,
    totalPositions: 2,
  });
  assert.equal(option.marketDataIssue, null);
  assert.ok(
    requested.some((path) => path.startsWith("/v2/stocks/bars/latest?")),
  );
  assert.ok(requested.some((path) => path.startsWith("/v2/stocks/bars?")));
});

test("portfolio: night estimate revalues stock positions from the latest overnight bar", async () => {
  const { fetcher: baseFetcher } = fake([], 200, false);
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v2/positions")
      return Response.json([
        {
          symbol: "SPY",
          asset_class: "us_equity",
          qty: "5",
          avg_entry_price: "690",
          current_price: "690",
          market_value: "3450",
          cost_basis: "3450",
          unrealized_pl: "0",
          unrealized_plpc: "0",
          unrealized_intraday_pl: "0",
        },
      ]);
    if (url.pathname === "/v2/stocks/snapshots")
      return url.searchParams.get("feed") === "boats"
        ? Response.json({ snapshots: {} })
        : Response.json({
            snapshots: {
              SPY: { latestTrade: { p: 700, t: "2026-10-13T23:00:00Z" } },
            },
          });
    if (url.pathname === "/v2/stocks/bars/latest")
      return Response.json({
        bars: { SPY: { c: 705, t: "2026-10-13T23:59:00Z" } },
      });
    return baseFetcher(input, init);
  }) as typeof fetch;
  const result = await handlePortfolio(
    keys,
    false,
    fetcher,
    Date.parse("2026-10-14T02:00:00Z"),
  );
  const body = result.body as Portfolio;
  assert.deepEqual(body.overnightEstimate, {
    equity: 100575,
    change: 75,
    pricedPositions: 1,
    totalPositions: 1,
  });
  assert.equal(body.positions[0]!.overnightPrice, 705);
});

test("portfolio: a closed market gets an estimate from after-hours snapshots", async () => {
  const { fetcher: baseFetcher } = fake([], 200, false);
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v2/positions")
      return Response.json([
        {
          symbol: "SPY",
          asset_class: "us_equity",
          qty: "5",
          avg_entry_price: "690",
          current_price: "690",
          market_value: "3450",
          cost_basis: "3450",
          unrealized_pl: "0",
          unrealized_plpc: "0",
          unrealized_intraday_pl: "0",
        },
      ]);
    if (url.pathname === "/v2/stocks/snapshots")
      return Response.json({
        snapshots: {
          SPY: { latestTrade: { p: 695, t: "2026-10-13T20:30:00Z" } },
        },
      });
    return baseFetcher(input, init);
  }) as typeof fetch;
  const body = (
    await handlePortfolio(
      keys,
      false,
      fetcher,
      Date.parse("2026-10-13T20:30:00Z"),
    )
  ).body as Portfolio;
  assert.equal(body.marketClosed, true);
  assert.deepEqual(body.overnightEstimate, {
    equity: 100525,
    change: 25,
    pricedPositions: 1,
    totalPositions: 1,
  });
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

test("delta exposure converts contracts into equivalent dollars of stock", () => {
  assert.equal(optionDeltaExposure(3, 700, 0.6), 126000);
  assert.equal(optionDeltaExposure(2, 100, -0.25), -5000);
});

test("portfolio view revalues option price, value, P&L and delta exposure together", () => {
  const position = {
    option: { right: "call", strike: 152.5, expiry: "2026-10-16" },
    qty: 28,
    entry: 0.51,
    price: 0.67,
    value: 1876,
    cost: 1428,
    pnl: 448,
    pnlPct: 31.37,
    overnightPrice: null,
    estimatedPrice: 0.56,
    underlyingPrice: 143.65,
    estimateBreakdown: { underlyingReference: 143.2 },
  } as Portfolio["positions"][number];
  const close = positionNumbers(position, "close", 100_000);
  assert.equal(close.price, 0.67);
  assert.equal(close.value, 1876);
  assert.equal(close.pnl, 448);
  assert.equal(close.underlyingPrice, 143.2);
  const overnight = positionNumbers(position, "overnight", 98_000);
  assert.equal(overnight.price, 0.56);
  assert.equal(overnight.value, 1568);
  assert.equal(overnight.pnl, 140);
  assert.equal(overnight.pnlPct, 9.8);
  assert.equal(overnight.sharePct, 1.6);
  assert.equal(overnight.sinceClose, -308);
  assert.equal(overnight.underlyingPrice, 143.65);

  const unavailable = positionNumbers(
    { ...position, estimatedPrice: null },
    "overnight",
    98_000,
  );
  assert.equal(unavailable.price, null);
  assert.equal(unavailable.value, null);
  assert.equal(unavailable.pnl, null);

  const stock = positionNumbers(
    {
      ...position,
      option: null,
      qty: 5,
      entry: 690,
      price: 690,
      value: 3450,
      cost: 3450,
      pnl: 0,
      pnlPct: 0,
      overnightPrice: 705,
      estimatedPrice: null,
    },
    "overnight",
    100_575,
  );
  assert.equal(stock.value, 3525);
  assert.equal(stock.pnl, 75);
});

test("portfolio: sell orders for more than is held are flagged", async () => {
  const { fetcher } = fake([
    order({ qty: "3" }),
    order({ id: "o2", qty: "2" }),
  ]);
  const body = (await handlePortfolio(keys, false, fetcher, now))
    .body as Portfolio;
  assert.deepEqual(body.shortRisks, [
    "OVERSOLD AMD261016C00720000: open sell orders for 5, 3 held",
  ]);
});

test("portfolio: live account host, missing keys and refused keys", async () => {
  const live = fake([]);
  assert.equal(
    ((await handlePortfolio(keys, true, live.fetcher, now)).body as Portfolio)
      .paper,
    false,
  );
  assert.ok(live.seen.every((s) => s.startsWith("GET ")));
  assert.ok(live.seen.some((s) => s.startsWith("GET api.alpaca.markets/")));
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
  assert.equal(seen.length, 6);
  await at(1000); // account and positions again, orders reused
  assert.deepEqual(
    seen.slice(6).map((s) => s.split("/v2/")[1]),
    ["account", "positions", "clock"],
  );
  const later = await at(6000);
  assert.equal(seen.length, 13);
  assert.equal((later.body as Portfolio).at, "2026-10-12T15:00:06.000Z");
  // The paper and live accounts never share an answer.
  await handlePortfolio(keys, true, fetcher, now + 6000, cache);
  assert.equal(seen.length, 17);
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
const amd = "AMD261016C00720000";
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
  assert.equal(trades[1]!.closedAt, "2026-10-07T15:00:00Z"); // Each fill of the trade, for its breakdown.
  assert.deepEqual(
    trades[1]!.fills!.map((f) => [f.side, f.qty, f.price]),
    [
      ["buy", 2, 1.6],
      ["buy", 1, 1.9],
      ["sell", 1, 2.5],
      ["sell", 2, 1.0],
    ],
  );
  assert.deepEqual(
    trades[0]!.fills!.map((f) => [f.side, f.qty, f.price, f.at]),
    [
      ["buy", 4, 0.5, "2026-10-08T14:00:00Z"],
      ["expired", 4, 0, "2026-10-09T20:00:00Z"],
    ],
  );
});

test("history: a trade still open keeps its fills for its window", () => {
  // User 2026-10-27: an ongoing trade opens the trade's window.
  const { open } = tradeLots([
    ...activities,
    fill("TSLA", "buy", 1, 410, "2026-10-09T16:00:00Z"),
    fill("TSLA", "sell", 2, 420, "2026-10-09T17:00:00Z"),
  ]);
  assert.deepEqual(
    open.map((t) => [t.symbol, t.qty, t.held, t.entry, t.sold, t.openedAt]),
    [["TSLA", 4, 2, 402.5, 840, "2026-10-09T15:00:00Z"]],
  );
  assert.deepEqual(
    open[0]!.fills.map((f) => [f.side, f.qty, f.price]),
    [
      ["buy", 3, 400],
      ["buy", 1, 410],
      ["sell", 2, 420],
    ],
  );
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
  assert.equal(body.baseEquity, 100000);
  assert.equal(body.from, new Date(at - 7 * 86400000).toISOString());
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

test("portfolio: overnight reference is the regular close, never the BOATS daily bar", async () => {
  const { fetcher: baseFetcher } = fake([order({})], 200, false);
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v2/stocks/snapshots")
      return Response.json({
        snapshots: {
          AMD:
            url.searchParams.get("feed") === "boats"
              ? {
                  // Overnight venue: its "daily" bar ends with night trading.
                  latestTrade: { p: 705, t: "2026-10-14T02:00:00Z" },
                  dailyBar: { c: 704, t: "2026-10-12T04:00:00Z" },
                }
              : {
                  dailyBar: { c: 690, t: "2026-10-12T04:00:00Z" },
                  prevDailyBar: { c: 680, t: "2026-10-09T04:00:00Z" },
                },
        },
      });
    if (url.pathname.startsWith("/v2/stocks/bars"))
      return Response.json({ message: "unavailable" }, { status: 500 });
    return baseFetcher(input, init);
  }) as typeof fetch;
  const result = await handlePortfolio(
    keys,
    false,
    fetcher,
    Date.parse("2026-10-14T02:00:00Z"),
  );
  const option = (result.body as Portfolio).positions.find((p) => p.option)!;
  assert.equal(option.underlyingPrice, 705);
  assert.equal(option.estimateBreakdown?.underlyingReference, 690);
  assert.equal(option.estimateBreakdown?.underlyingReferenceSource, "close");
  assert.equal(option.estimateBreakdown?.underlyingMove, 15);
});

test("portfolio: reads Alpaca's real snapshot shape (symbols at the top, minuteBar, impliedVolatility)", async () => {
  const { fetcher: baseFetcher } = fake([order({})], 200, false);
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    // Pre-market, as Alpaca answered on 2026-10-14 (values synthetic).
    if (url.pathname === "/v2/stocks/snapshots")
      return Response.json({
        AMD: {
          latestTrade: { p: 704, t: "2026-10-13T11:00:00Z" },
          minuteBar: { c: 705, t: "2026-10-13T11:20:00Z" },
          dailyBar: { c: 690, t: "2026-10-12T04:00:00Z" },
        },
      });
    if (url.pathname === "/v2/stocks/bars") return Response.json({ bars: {} });
    if (url.pathname === "/v1beta1/options/snapshots")
      return Response.json({
        snapshots: {
          AMD261016C00720000: {
            impliedVolatility: 0.4,
            latestQuote: { bp: 2, ap: 2.2, t: "2026-10-12T19:59:59Z" },
          },
        },
      });
    return baseFetcher(input, init);
  }) as typeof fetch;
  const result = await handlePortfolio(
    keys,
    false,
    fetcher,
    Date.parse("2026-10-13T11:22:00Z"),
  );
  const option = (result.body as Portfolio).positions.find((p) => p.option)!;
  assert.equal(option.underlyingPrice, 705);
  assert.equal(option.underlyingPriceSource, "bar");
  assert.equal(option.impliedVolatility, 0.4);
  assert.equal(option.estimateBreakdown?.underlyingReference, 690);
  assert.equal(option.estimateBreakdown?.model, "black-scholes");
  assert.equal(option.marketDataIssue, null);
});
