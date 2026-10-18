// SYNTHETIC bars, quote, asset and news.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleTicker,
  tickerStats,
} from "../packages/market-data/src/ticker.js";

const now = Date.parse("2026-10-16T20:00:00Z");
const day = 86_400_000;
// A close every day for 400 days: the stock rises 1 a day from 100, SPY
// half as fast from 400.
const series = (from: number, step: number) =>
  Array.from({ length: 400 }, (_, i) => {
    const close = from + i * step;
    return {
      start: Math.floor((now - (399 - i) * day) / 1000),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000 + i,
    };
  });

test("ticker stats: the year's range, average volume and returns vs SPY", () => {
  const stock = series(100, 1);
  const spy = series(400, 0.5);
  const s = tickerStats(stock, spy, now)!;
  assert.equal(s.yearHigh, 499 + 1);
  assert.equal(s.yearLow, 100 + 34 - 1); // 365 days back
  assert.equal(s.avgVolume30, Math.round(1000 + (370 + 399) / 2));
  const week = s.returns.find((r) => r.period === "1W")!;
  assert.ok(Math.abs(week.stock! - (7 / 492) * 100) < 1e-9);
  assert.ok(Math.abs(week.spy! - (3.5 / 596) * 100) < 1e-9);
  assert.equal(s.closes.length, 366);
  // Without enough history a period is null, not a guess.
  const young = tickerStats(stock.slice(-20), spy, now)!;
  assert.equal(young.returns.find((r) => r.period === "1M")!.stock, null);
  assert.equal(tickerStats([], spy, now), null);
});

test("ticker: asset, quote, stats and news; a failed part is left out", async () => {
  const seen: string[] = [];
  const fetcher = (async (url: string | URL) => {
    const u = String(url);
    seen.push(u);
    if (u.includes("/snapshot"))
      return Response.json({
        latestTrade: { p: 498.5, t: "2026-10-16T19:59:00Z" },
        latestQuote: { bp: 498.4, ap: 498.6 },
        dailyBar: { o: 495, h: 500, l: 494, v: 123456, vw: 497.2 },
        prevDailyBar: { c: 494 },
      });
    if (u.includes("/v2/assets/"))
      return Response.json({
        name: "Synthetic Corp",
        exchange: "NASDAQ",
        tradable: true,
        shortable: true,
        attributes: ["has_options"],
      });
    if (u.includes("/v1beta1/news"))
      return Response.json({
        news: [
          {
            headline: "Synthetic Corp ships a thing",
            source: "benzinga",
            url: "https://example.test/a",
            created_at: "2026-10-16T12:00:00Z",
            summary: "",
          },
          { headline: "Bad link", url: "javascript:alert(1)" },
        ],
      });
    if (u.includes("/bars")) {
      const spy = u.includes("/stocks/SPY/");
      return Response.json({
        bars: series(spy ? 400 : 100, spy ? 0.5 : 1).map((b) => ({
          t: new Date(b.start * 1000).toISOString(),
          o: b.open,
          h: b.high,
          l: b.low,
          c: b.close,
          v: b.volume,
        })),
        next_page_token: null,
      });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const r = await handleTicker(
    { ticker: "sync" },
    { key: "k", secret: "s" },
    "https://paper-api.example.test",
    fetcher,
    now,
  );
  assert.equal(r.status, 200);
  const body = r.body as Exclude<typeof r.body, { error: string }>;
  assert.equal(body.ticker, "SYNC");
  assert.deepEqual(body.asset, {
    name: "Synthetic Corp",
    exchange: "NASDAQ",
    tradable: true,
    shortable: true,
    optionable: true,
  });
  assert.equal(body.quote?.last, 498.5);
  assert.equal(body.quote?.previousClose, 494);
  assert.equal(body.stats?.yearHigh, 500);
  // Only https links are kept.
  assert.deepEqual(
    body.news.map((n) => n.headline),
    ["Synthetic Corp ships a thing"],
  );
  assert.ok(seen.some((u) => u.startsWith("https://paper-api.example.test")));

  // News and the asset fail: the rest still answers.
  const partial = await handleTicker(
    { ticker: "SYNC" },
    { key: "k", secret: "s" },
    "https://paper-api.example.test",
    (async (url: string | URL) =>
      String(url).includes("/news") || String(url).includes("/assets/")
        ? new Response("no", { status: 500 })
        : fetcher(url)) as typeof fetch,
    now,
  );
  assert.equal(partial.status, 200);
  const p = partial.body as typeof body;
  assert.equal(p.asset, null);
  assert.deepEqual(p.news, []);
  assert.equal(p.quote?.last, 498.5);

  assert.equal(
    (
      await handleTicker(
        { ticker: "BAD$" },
        { key: "k", secret: "s" },
        "x",
        fetcher,
        now,
      )
    ).status,
    400,
  );
});
