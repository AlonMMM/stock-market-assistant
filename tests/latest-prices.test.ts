import assert from "node:assert/strict";
import test from "node:test";
import { handleLatestPrices } from "../packages/market-data/src/latest-prices.js";
import {
  boardTrading,
  watchRows,
  withLivePrices,
} from "../apps/web/src/live-model.js";
import type { Board } from "../packages/market-data/src/board.js";

const credentials = { key: "k", secret: "s", sipDelayMinutes: 0 };

test("latest prices: one Alpaca request for every symbol, SIP feed", async () => {
  const urls: string[] = [];
  const fetcher = (async (url: URL | RequestInfo) => {
    urls.push(String(url));
    return Response.json({
      trades: {
        AAPL: { t: "2026-10-19T14:30:01.5Z", p: 231.42, s: 100 },
        MSFT: { t: "2026-10-19T14:30:00Z", p: 0 }, // no price: left out
      },
    });
  }) as typeof fetch;
  const r = await handleLatestPrices(" aapl,MSFT,aapl ", credentials, fetcher);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    prices: {
      AAPL: { price: 231.42, at: Date.parse("2026-10-19T14:30:01.5Z") },
    },
  });
  assert.equal(
    urls[0],
    "https://data.alpaca.markets/v2/stocks/trades/latest?symbols=AAPL%2CMSFT&feed=sip",
  );
});

test("latest prices: refused without real-time SIP, bad symbols or keys", async () => {
  const never = (async () => {
    throw new Error("must not be called");
  }) as typeof fetch;
  assert.equal(
    (
      await handleLatestPrices(
        "AAPL",
        { ...credentials, sipDelayMinutes: 15 },
        never,
      )
    ).status,
    409,
  );
  assert.equal((await handleLatestPrices("", credentials, never)).status, 400);
  assert.equal(
    (await handleLatestPrices("AAPL,<x>", credentials, never)).status,
    400,
  );
  assert.equal((await handleLatestPrices("AAPL", {}, never)).status, 503);
  const failing = (async () =>
    new Response("no", { status: 429 })) as typeof fetch;
  const r = await handleLatestPrices("AAPL", credentials, failing);
  assert.equal(r.status, 502);
});

// Synthetic board: 5-minute bars from 14:30 UTC (09:30 New York).
const open = Date.parse("2026-10-19T13:30:00Z") / 1000;
const board = (): Board => ({
  source: "alpaca",
  feed: "sip",
  date: "2026-10-19",
  open,
  close: open + 6.5 * 3600,
  watchlist: ["AAPL"],
  benchmarks: {},
  series: [
    {
      ticker: "AAPL",
      previousClose: 200,
      points: [
        [open, 201],
        [open + 300, 202],
      ],
      stats: {
        asOf: open + 600,
        dayLow: 199,
        dayHigh: 203,
        volume: 1000,
        typicalVolume: 1000,
        relVolume: 1,
      },
    },
    { ticker: "SPY", previousClose: 500, points: [[open, 501]] },
  ],
});
const at = (seconds: number) => (open + seconds) * 1000;

test("live prices: a trade becomes the close of its 5-minute bar", () => {
  const b = withLivePrices(board(), { AAPL: { price: 210, at: at(420) } });
  const s = b.series[0]!;
  assert.deepEqual(s.points.at(-1), [open + 300, 210]);
  assert.equal(s.points.length, 2);
  assert.equal(s.stats?.dayHigh, 210);
  assert.equal(s.stats?.dayLow, 199);
  // Last and Change % follow it.
  const row = watchRows(b, new Map(), "SPY")[0]!;
  assert.equal(row.last, 210);
  assert.ok(Math.abs(row.change! - 5) < 1e-9);
});

test("live prices: a trade after the last bar starts a new one", () => {
  const b = withLivePrices(board(), { AAPL: { price: 195, at: at(905) } });
  assert.deepEqual(b.series[0]!.points.at(-1), [open + 900, 195]);
  assert.equal(b.series[0]!.points.length, 3);
  assert.equal(b.series[0]!.stats?.dayLow, 195);
});

test("live prices: an older trade or an unknown symbol changes nothing", () => {
  const before = board();
  const b = withLivePrices(before, {
    AAPL: { price: 1, at: at(100) },
    TSLA: { price: 300, at: at(400) },
  });
  assert.deepEqual(b.series, before.series);
});

test("live prices are read only from 04:00 to 20:00 New York", () => {
  const b = board();
  assert.equal(boardTrading(b, at(-5.5 * 3600 - 1)), false);
  assert.equal(boardTrading(b, at(-5.5 * 3600)), true);
  assert.equal(boardTrading(b, at(6.5 * 3600 + 4 * 3600 - 1)), true);
  assert.equal(boardTrading(b, at(6.5 * 3600 + 4 * 3600)), false);
});

test("the Worker answers /api/prices from Alpaca, uncached", async () => {
  const { default: worker } = await import("../apps/api/src/worker.js");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    assert.match(String(input), /\/v2\/stocks\/trades\/latest\?symbols=NVDA/);
    return Response.json({
      trades: { NVDA: { t: "2026-10-19T14:30:00Z", p: 180.5 } },
    });
  }) as typeof fetch;
  try {
    const response = await worker.fetch(
      new Request("https://app.test/api/prices?symbols=NVDA"),
      { ALPACA_API_KEY: "k", ALPACA_API_SECRET: "s" },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), {
      prices: {
        NVDA: { price: 180.5, at: Date.parse("2026-10-19T14:30:00Z") },
      },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
