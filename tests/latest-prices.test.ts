import assert from "node:assert/strict";
import test from "node:test";
import {
  handleLatestPrices,
  type LatestPrices,
} from "../packages/market-data/src/latest-prices.js";
import { overnightSession } from "../packages/market-data/src/overnight.js";
import {
  boardTrading,
  ibChange,
  ibPct,
  ibVolume,
  regularClose,
  watchRows,
  withLivePrices,
} from "../apps/web/src/live-model.js";
import type { Board } from "../packages/market-data/src/board.js";

const credentials = { key: "k", secret: "s", sipDelayMinutes: 0 };
// Monday 2026-10-19 10:30 New York: the regular session, SIP.
const daytime = Date.parse("2026-10-19T14:30:00Z");
// Sunday 2026-10-25 21:00 New York: the night before Monday, BOATS.
const sundayNight = Date.parse("2026-10-26T01:00:00Z");

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
  const r = await handleLatestPrices(
    " aapl,MSFT,aapl ",
    credentials,
    fetcher,
    undefined,
    daytime,
  );
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
  const r = await handleLatestPrices(
    "AAPL",
    credentials,
    failing,
    undefined,
    daytime,
  );
  assert.equal(r.status, 502);
});

test("overnight session: 20:00–04:00 New York before each trading day", () => {
  // Sunday 21:00 New York leads into Monday.
  assert.deepEqual(overnightSession(sundayNight), {
    date: "2026-10-26",
    start: Date.parse("2026-10-26T00:00:00Z"),
    end: Date.parse("2026-10-26T08:00:00Z"),
  });
  // Monday 03:59 still the night; 04:00 is pre-market.
  assert.equal(
    overnightSession(Date.parse("2026-10-26T07:59:00Z"))?.date,
    "2026-10-26",
  );
  assert.equal(overnightSession(Date.parse("2026-10-26T08:00:00Z")), null);
  // Monday 19:59 after-hours; 20:00 the night before Tuesday.
  assert.equal(overnightSession(Date.parse("2026-10-26T23:59:00Z")), null);
  assert.equal(
    overnightSession(Date.parse("2026-10-27T00:00:00Z"))?.date,
    "2026-10-27",
  );
  // Friday night and Saturday: no session follows, no night.
  assert.equal(overnightSession(Date.parse("2026-10-31T01:00:00Z")), null);
  assert.equal(overnightSession(Date.parse("2026-10-31T15:00:00Z")), null);
  // The eve of Thanksgiving (New York in winter time, UTC−5): none.
  assert.equal(overnightSession(Date.parse("2026-11-26T02:00:00Z")), null);
  // The night after it leads into Friday.
  assert.equal(
    overnightSession(Date.parse("2026-11-27T02:00:00Z"))?.date,
    "2026-11-27",
  );
});

test("latest prices overnight: the BOATS feed, marked as the night", async () => {
  const urls: string[] = [];
  const fetcher = (async (url: URL | RequestInfo) => {
    urls.push(String(url));
    return Response.json({
      trades: { AAPL: { t: "2026-10-26T00:59:30Z", p: 262.1 } },
    });
  }) as typeof fetch;
  const r = await handleLatestPrices(
    "AAPL",
    credentials,
    fetcher,
    undefined,
    sundayNight,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    prices: {
      AAPL: { price: 262.1, at: Date.parse("2026-10-26T00:59:30Z") },
    },
    overnight: {
      date: "2026-10-26",
      since: Date.parse("2026-10-26T00:00:00Z"),
    },
  });
  assert.equal(
    urls[0],
    "https://data.alpaca.markets/v2/stocks/trades/latest?symbols=AAPL&feed=boats",
  );
});

test("latest prices overnight: SIP answers when BOATS is refused", async () => {
  const urls: string[] = [];
  const fetcher = (async (url: URL | RequestInfo) => {
    urls.push(String(url));
    return /feed=boats/.test(String(url))
      ? new Response("no", { status: 403 })
      : Response.json({
          trades: { AAPL: { t: "2026-10-23T23:59:00Z", p: 260 } },
        });
  }) as typeof fetch;
  const r = await handleLatestPrices(
    "AAPL",
    credentials,
    fetcher,
    undefined,
    sundayNight,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    prices: { AAPL: { price: 260, at: Date.parse("2026-10-23T23:59:00Z") } },
  });
  assert.deepEqual(
    urls.map((u) => new URL(u).searchParams.get("feed")),
    ["boats", "sip"],
  );
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

test("live prices are read from 04:00 to 20:00 and through the night", () => {
  const b = board(); // Monday
  assert.equal(boardTrading(b, at(-5.5 * 3600 - 1)), false);
  assert.equal(boardTrading(b, at(-5.5 * 3600)), true);
  assert.equal(boardTrading(b, at(6.5 * 3600 + 4 * 3600 - 1)), true);
  // 20:00 Monday: the night before Tuesday (BOATS), until 04:00.
  assert.equal(boardTrading(b, at(6.5 * 3600 + 4 * 3600)), true);
  assert.equal(boardTrading(b, at(6.5 * 3600 + 12 * 3600 - 1)), true);
  // A Friday board stops at 20:00: no session follows until Monday.
  const friday: Board = {
    ...b,
    date: "2026-10-23",
    open: Date.parse("2026-10-23T13:30:00Z") / 1000,
    close: Date.parse("2026-10-23T20:00:00Z") / 1000,
  };
  const fridayEnd = Date.parse("2026-10-24T00:00:00Z");
  assert.equal(boardTrading(friday, fridayEnd - 1000), true);
  assert.equal(boardTrading(friday, fridayEnd), false);
  assert.equal(boardTrading(friday, fridayEnd + 3600000), false);
});

// 21:00 Monday 2026-10-19 New York: the night before Tuesday.
const night = at(6.5 * 3600 + 5 * 3600);

test("overnight: a BOATS print against the day's regular close", () => {
  const b = board();
  assert.equal(regularClose(b, b.series[0]), 202);
  const prints = { AAPL: { price: 205, at: night - 30000 } };
  // The print is not added to the day's line.
  assert.deepEqual(withLivePrices(b, prints).series, b.series);
  const row = watchRows(b, new Map(), "SPY", { now: night, night: prints })[0]!;
  assert.equal(row.mark, "night");
  assert.equal(row.last, 205);
  assert.ok(Math.abs(row.changeUsd! - 3) < 1e-9);
  assert.ok(Math.abs(row.change! - (3 / 202) * 100) < 1e-9);
  // SPY has no night print: no benchmark change, so no excess.
  assert.equal(row.benchChange, null);
  assert.equal(row.excess, null);
});

test("overnight without a print: the close, marked C, no change", () => {
  const b = board();
  // A print from before 20:00 is the day's, not the night's.
  const prints = { AAPL: { price: 204, at: at(6.5 * 3600 + 3600) } };
  const row = watchRows(b, new Map(), "SPY", { now: night, night: prints })[0]!;
  assert.equal(row.mark, "close");
  assert.equal(row.last, 202);
  assert.equal(row.change, null);
  assert.equal(row.changeUsd, null);
});

test("closed (a weekend): the close with the day's change", () => {
  const b = board();
  const saturday = Date.parse("2026-10-24T15:00:00Z");
  const row = watchRows(b, new Map(), "SPY", { now: saturday })[0]!;
  assert.equal(row.mark, "close");
  assert.equal(row.last, 202);
  assert.ok(Math.abs(row.changeUsd! - 2) < 1e-9);
});

test("pre-market before a stock's first print: the previous close, C", () => {
  const b = board();
  b.series[0]!.points = [];
  const row = watchRows(b, new Map(), "SPY", { now: at(-3600) })[0]!;
  assert.equal(row.mark, "close");
  assert.equal(row.last, 200);
  assert.equal(row.change, null);
  // Trading, with prints: live against the previous close.
  const live = watchRows(board(), new Map(), "SPY", { now: at(900) })[0]!;
  assert.equal(live.mark, "live");
  assert.equal(live.last, 202);
});

test("IBKR's number style", () => {
  assert.equal(ibChange(0.53), "+0.53");
  assert.equal(ibChange(-1.63), "-1.63");
  assert.equal(ibChange(-0.001), "+0.00");
  assert.equal(ibPct(0.0712), "0.07%");
  assert.equal(ibPct(-0.23), "-0.23%");
  assert.equal(ibVolume(41200), "41.2K");
  assert.equal(ibVolume(151000), "151K");
  assert.equal(ibVolume(897), "897");
  assert.equal(ibVolume(5620), "5.62K");
  assert.equal(ibVolume(999700), "1.00M");
  assert.equal(ibVolume(1234567), "1.23M");
  assert.equal(ibVolume(null), "—");
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
    // Only the prices: at night the answer also names the overnight session.
    assert.deepEqual(((await response.json()) as LatestPrices).prices, {
      NVDA: { price: 180.5, at: Date.parse("2026-10-19T14:30:00Z") },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
