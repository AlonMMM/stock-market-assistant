import assert from "node:assert/strict";
import test from "node:test";
import { handleCandles } from "../packages/market-data/src/candles.js";

// Synthetic bars: Monday 2026-10-12, 10:00 and 10:01 New York.
const credentials = { key: "k", secret: "s", sipDelayMinutes: 0 };
const bar = (t: string, o: number, h: number, l: number, c: number) => ({
  t,
  o,
  h,
  l,
  c,
  v: 1000,
});
const bars = [
  bar("2026-10-12T14:00:00Z", 100, 101, 99.5, 100.5),
  bar("2026-10-12T14:01:00Z", 100.5, 100.8, 100.2, 100.6),
];

function fetcher(snapshot: unknown, seen: string[] = []) {
  return (async (input: URL) => {
    seen.push(input.pathname);
    if (input.pathname.endsWith("/snapshot"))
      return snapshot === null
        ? new Response("no", { status: 500 })
        : Response.json(snapshot);
    return Response.json({ bars, next_page_token: null });
  }) as unknown as typeof fetch;
}
const query = { ticker: "nvda", date: "2026-10-12" };

test("candles: the day's minute bars with high and low, and the previous close", async () => {
  const seen: string[] = [];
  const out = await handleCandles(
    query,
    credentials,
    fetcher(
      {
        latestTrade: { p: 100.7, t: "2026-10-12T14:01:40Z" },
        prevDailyBar: { c: 98 },
      },
      seen,
    ),
    Date.parse("2026-10-12T14:02:10Z"),
  );
  assert.equal(out.status, 200);
  assert.ok("candles" in out.body);
  assert.deepEqual(seen.sort(), [
    "/v2/stocks/NVDA/bars",
    "/v2/stocks/NVDA/snapshot",
  ]);
  assert.equal(out.body.previousClose, 98);
  assert.deepEqual(
    out.body.candles.map((c) => [c.session, c.open, c.high, c.low, c.close]),
    [
      ["regular", 100, 101, 99.5, 100.5],
      // A trade inside the last bar's minute moves its close, not its range.
      ["regular", 100.5, 100.8, 100.2, 100.7],
    ],
  );
});

test("candles: a trade in the minute still forming opens a new candle", async () => {
  const out = await handleCandles(
    query,
    credentials,
    fetcher({ latestTrade: { p: 101.2, t: "2026-10-12T14:02:20Z" } }),
    Date.parse("2026-10-12T14:02:30Z"),
  );
  assert.ok("candles" in out.body);
  assert.deepEqual(out.body.candles.at(-1), {
    start: Date.parse("2026-10-12T14:02:00Z") / 1000,
    session: "regular",
    open: 100.6,
    high: 101.2,
    low: 100.6,
    close: 101.2,
    volume: 0,
  });
  assert.deepEqual(out.body.last, {
    price: 101.2,
    at: Date.parse("2026-10-12T14:02:20Z"),
  });
});

test("candles: without the snapshot the bars still come; bad input is refused", async () => {
  const out = await handleCandles(
    query,
    credentials,
    fetcher(null),
    Date.parse("2026-10-12T14:02:30Z"),
  );
  assert.ok("candles" in out.body);
  assert.equal(out.body.candles.length, 2);
  assert.equal(out.body.last, null);
  assert.equal(out.body.previousClose, null);
  const bad = async (q: object) =>
    (await handleCandles(q, credentials, fetcher(null))).status;
  assert.equal(await bad({ ticker: "NVDA", date: "2026-10-11" }), 400); // Sunday
  assert.equal(await bad({ ticker: "../x", date: "2026-10-12" }), 400);
  assert.equal(await bad({ date: "2026-10-12" }), 400);
  assert.equal(
    (await handleCandles(query, { key: "", secret: "" }, fetcher(null))).status,
    503,
  );
});

test("candles: the overnight after the session, from its own feed", async () => {
  const seen: string[] = [];
  const feeds: string[] = [];
  const night = [
    // Monday 21:00 and Tuesday 01:30 New York (UTC−4).
    bar("2026-10-13T01:00:00Z", 101, 101.2, 100.9, 101.1),
    bar("2026-10-13T05:30:00Z", 101.1, 101.4, 101, 101.3),
  ];
  const f = (async (input: URL) => {
    seen.push(input.pathname);
    if (input.pathname.endsWith("/snapshot")) return Response.json({});
    feeds.push(input.searchParams.get("feed")!);
    return Response.json({
      bars: input.searchParams.get("feed") === "boats" ? night : bars,
      next_page_token: null,
    });
  }) as unknown as typeof fetch;
  const at = Date.parse("2026-10-13T06:00:00Z"); // Tuesday 02:00
  const out = await handleCandles(query, credentials, f, at);
  assert.ok("candles" in out.body);
  assert.deepEqual(feeds.sort(), ["boats", "sip"]);
  assert.deepEqual(
    out.body.candles.map((c) => [c.session, c.close]),
    [
      ["regular", 100.5],
      ["regular", 100.6],
      ["overnight", 101.1],
      ["overnight", 101.3],
    ],
  );
  // When the plan refuses the overnight feed, the day still loads.
  const failing = (async (input: URL) =>
    input.searchParams.get("feed") === "boats"
      ? new Response("no", { status: 403 })
      : f(input)) as unknown as typeof fetch;
  const refused = await handleCandles(query, credentials, failing, at);
  assert.ok("candles" in refused.body);
  assert.equal(refused.body.candles.length, 2);
});
