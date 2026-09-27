import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cachedHistory,
  D1BarCache,
  MemoryBarCache,
  newYorkDates,
  type BarCache,
} from "../packages/market-data/src/bar-cache.js";
import type { RawBar } from "../packages/market-data/src/bars.js";
import { handleBacktest } from "../packages/market-data/src/backtest.js";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";

// One regular-session bar at 14:00Z (10:00 EDT) on each weekday.
function source(skip: string[] = []) {
  const calls: [string, string][] = [];
  const fetchRange = async (start: string, end: string) => {
    calls.push([start, end]);
    const rows: RawBar[] = [];
    for (let t = Date.parse(start); t < Date.parse(end); t += 3600000) {
      const d = new Date(t);
      const date = d.toISOString().slice(0, 10);
      if (d.getUTCHours() !== 14 || [0, 6].includes(d.getUTCDay())) continue;
      if (skip.includes(date)) continue;
      rows.push({
        start: t / 1000,
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
      });
    }
    return rows;
  };
  return { calls, fetchRange };
}
const later = Date.parse("2026-07-01T00:00:00Z");
const range = ["2026-06-01T04:00:00Z", "2026-06-06T04:00:00Z"] as const; // Mon–Fri

test("New York days are midnight to midnight in New York time", () => {
  assert.deepEqual(
    newYorkDates(
      Date.parse("2026-06-01T00:00:00Z"),
      Date.parse("2026-06-02T12:00:00Z"),
    ),
    ["2026-05-31", "2026-06-01", "2026-06-02"],
  );
});

test("finished days are cached; repeats and overlaps fetch only missing days", async () => {
  const cache = new MemoryBarCache();
  const s = source();
  const stats = { hits: 0, misses: 0 };
  const first = await cachedHistory(
    "NVDA",
    ...range,
    s.fetchRange,
    cache,
    later,
    stats,
  );
  assert.equal(first.length, 5);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(stats, { hits: 0, misses: 5 });
  const again = await cachedHistory(
    "NVDA",
    ...range,
    s.fetchRange,
    cache,
    later,
    stats,
  );
  assert.deepEqual(again, first);
  assert.equal(s.calls.length, 1, "served from the cache");
  assert.deepEqual(stats, { hits: 5, misses: 5 });
  // Extend by the weekend and Monday: one request for the new days only.
  const wider = await cachedHistory(
    "NVDA",
    range[0],
    "2026-06-09T04:00:00Z",
    s.fetchRange,
    cache,
    later,
  );
  assert.equal(wider.length, 6);
  assert.deepEqual(s.calls[1], [
    "2026-06-06T04:00:00.000Z",
    "2026-06-09T04:00:00.000Z",
  ]);
  // Empty weekend days are stored, so the next wider request fetches nothing.
  await cachedHistory(
    "NVDA",
    range[0],
    "2026-06-09T04:00:00Z",
    s.fetchRange,
    cache,
    later,
  );
  assert.equal(s.calls.length, 2);
  // Keys are separate per symbol.
  await cachedHistory("AAPL", ...range, s.fetchRange, cache, later);
  assert.equal(s.calls.length, 3);
});

test("unfinished days and empty trading days are never stored", async () => {
  const cache = new MemoryBarCache();
  const s = source(["2026-06-03"]);
  // Data is final only until Thursday 15:00Z: Thursday and Friday unfinished.
  const ready = Date.parse("2026-06-04T15:00:00Z");
  await cachedHistory(
    "NVDA",
    range[0],
    "2026-06-04T15:00:00Z",
    s.fetchRange,
    cache,
    ready,
  );
  const stored = [...cache.days.keys()].map((k) => k.split("|")[1]);
  assert.deepEqual(
    stored,
    ["2026-06-01", "2026-06-02"],
    "not the gap, not Thursday",
  );
  await cachedHistory(
    "NVDA",
    range[0],
    "2026-06-04T15:00:00Z",
    s.fetchRange,
    cache,
    ready,
  );
  assert.equal(
    s.calls.at(-1)![0],
    "2026-06-03T04:00:00.000Z",
    "refetches from the gap",
  );
});

test("a failing cache falls back to fetching", async () => {
  const broken: BarCache = {
    get: async () => {
      throw new Error("down");
    },
    put: async () => {
      throw new Error("down");
    },
  };
  const s = source();
  const rows = await cachedHistory(
    "NVDA",
    ...range,
    s.fetchRange,
    broken,
    later,
  );
  assert.equal(rows.length, 5);
});

test("the D1 cache stores days and reads them with one range query", async () => {
  const cache = new D1BarCache(new SqliteD1(":memory:"));
  const days = new Map<string, RawBar[]>();
  for (let i = 0; i < 120; i++) {
    const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    days.set(
      date,
      i % 2
        ? []
        : [{ start: i, open: 1, high: 2, low: 0.5, close: 1.5, volume: i }],
    );
  }
  await cache.put("NVDA:sip:1Min:raw", days);
  const read = await cache.get("NVDA:sip:1Min:raw", [...days.keys()]);
  assert.equal(read.size, 120);
  assert.deepEqual(read.get("2026-01-01"), days.get("2026-01-01"));
  assert.equal(
    (await cache.get("AAPL:sip:1Min:raw", [...days.keys()])).size,
    0,
  );
  // Only requested days are returned, even when the range spans others.
  const some = await cache.get("NVDA:sip:1Min:raw", [
    "2026-01-01",
    "2026-03-01",
  ]);
  assert.deepEqual([...some.keys()], ["2026-01-01", "2026-03-01"]);
});

test("a cached backtest returns the same result and reports cache use", async () => {
  let requests = 0;
  const fetcher = (async (input: URL | RequestInfo) => {
    requests++;
    const url = new URL(String(input));
    const start = Date.parse(url.searchParams.get("start")!);
    const end = Date.parse(url.searchParams.get("end")!);
    const bars = [];
    // A 14:00Z bar on each weekday inside [start, end).
    if (url.searchParams.get("timeframe") === "1Min")
      for (
        let t = Math.floor(start / 86400000) * 86400000 + 14 * 3600000;
        t < end;
        t += 86400000
      )
        if (t >= start && ![0, 6].includes(new Date(t).getUTCDay()))
          bars.push({
            t: new Date(t).toISOString(),
            o: 1,
            h: 1,
            l: 1,
            c: 1,
            v: 100,
          });
    return Response.json({ bars, next_page_token: null });
  }) as typeof fetch;
  const cache = new MemoryBarCache();
  const body = { tickers: ["AAPL"], from: "2026-06-01", to: "2026-06-05" };
  const first = await handleBacktest(
    body,
    { key: "k", secret: "s" },
    fetcher,
    later,
    cache,
  );
  const firstRequests = requests;
  const second = await handleBacktest(
    body,
    { key: "k", secret: "s" },
    fetcher,
    later,
    cache,
  );
  assert.equal(first.status, 200);
  const a = first.body as { cache: { hits: number; misses: number } };
  const b = second.body as { cache: { hits: number; misses: number } };
  assert.equal(a.cache.hits, 0);
  assert.ok(a.cache.misses > 20);
  assert.equal(b.cache.misses, 0);
  assert.equal(b.cache.hits, a.cache.misses);
  // Only the daily bars (for beta) are requested again.
  assert.ok(requests - firstRequests < firstRequests);
  const { cache: _a, ...restA } = first.body as Record<string, unknown>;
  const { cache: _b, ...restB } = second.body as Record<string, unknown>;
  assert.deepEqual(restB, restA);
});

test("D1 writes fit Cloudflare's per-request limits: 10 days per statement, compressed", async () => {
  const sqlite = new SqliteD1(":memory:");
  let statements = 0;
  const counting = {
    prepare: (sql: string) => sqlite.prepare(sql),
    batch: async (list: Parameters<typeof sqlite.batch>[0]) => {
      statements += list.length;
      return sqlite.batch(list);
    },
  };
  const cache = new D1BarCache(counting);
  const days = new Map<string, RawBar[]>();
  const bar = (i: number): RawBar => ({
    start: 1790150400 + i * 60,
    open: 228.75,
    high: 229.25,
    low: 228.4,
    close: 229.06 + i / 100,
    volume: 93972 + i,
  });
  for (let d = 0; d < 38; d++) {
    const date = new Date(Date.UTC(2026, 7, 20 + d)).toISOString().slice(0, 10);
    days.set(
      date,
      Array.from({ length: 900 }, (_, i) => bar(i + d)),
    );
  }
  await cache.put("NVDA:sip:1Min:raw", days);
  assert.equal(statements, 4, "38 days in 4 statements");
  const read = await cache.get("NVDA:sip:1Min:raw", [...days.keys()]);
  assert.deepEqual(read, days);
  // Stored compressed, far below the 100 KB statement limit for 10 days.
  const row = (
    await sqlite
      .prepare("SELECT bars FROM minute_bars LIMIT 1")
      .all<{ bars: string }>()
  ).results[0]!;
  assert.ok(row.bars.startsWith("gz:"));
  assert.ok(row.bars.length * 10 < 100_000, `${row.bars.length} bytes a day`);
  // Rows written before compression still read.
  await sqlite
    .prepare("INSERT INTO minute_bars VALUES (?, ?, ?, ?)")
    .bind("OLD:sip:1Min:raw", "2026-09-01", "[[1,2,3,1,2,10]]", 0)
    .run();
  assert.deepEqual(
    (await cache.get("OLD:sip:1Min:raw", ["2026-09-01"])).get("2026-09-01"),
    [{ start: 1, open: 2, high: 3, low: 1, close: 2, volume: 10 }],
  );
});

test("cache errors are counted and reported, results unaffected", async () => {
  const broken: BarCache = {
    get: async () => {
      throw new Error("Too many API requests by single worker invocation.");
    },
    put: async () => {
      throw new Error("Too many API requests by single worker invocation.");
    },
  };
  const stats = { hits: 0, misses: 0 };
  const s = source();
  const rows = await cachedHistory(
    "NVDA",
    ...range,
    s.fetchRange,
    broken,
    later,
    stats,
  );
  assert.equal(rows.length, 5);
  assert.deepEqual(stats, {
    hits: 0,
    misses: 5,
    errors: 2,
    lastError: "Too many API requests by single worker invocation.",
  });
});
