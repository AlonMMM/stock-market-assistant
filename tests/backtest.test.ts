import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../apps/api/src/app.js";
import worker from "../apps/api/src/worker.js";
import {
  backtestWindow,
  BacktestRun,
  decodePart,
  encodePart,
  handleBacktest,
  parseBacktest,
  maxSymbolsPerRequest,
  runBacktest,
} from "../packages/market-data/src/backtest.js";
import type { RawBar } from "../packages/market-data/src/bars.js";
import {
  D1Blobs,
  ResultCache,
} from "../packages/market-data/src/result-cache.js";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";
import { previousSessions } from "../packages/market-data/src/calendar.js";
import type { BaselineCounts } from "../packages/market-data/src/outcome.js";
import { pairedDaily } from "./analysis-fixtures.js";
import { marksScore } from "../packages/market-data/src/marks-vs-spy.js";

// Synthetic regular-session bars (EDT: 13:30Z–20:00Z), flat at 100 on 1,000
// shares a minute, with a rising 20,000-share burst on 2026-06-03 14:00Z–14:04Z.
const from = "2026-06-01";
const to = "2026-06-05";
const sessions = [
  ...previousSessions(from, 20),
  "2026-06-01",
  "2026-06-02",
  "2026-06-03",
  "2026-06-04",
  "2026-06-05",
];
function syntheticBars(skip: string[] = []): RawBar[] {
  const rows: RawBar[] = [];
  for (const date of sessions) {
    if (skip.includes(date)) continue;
    const open = Date.parse(`${date}T13:30:00Z`) / 1000;
    for (let i = 0; i < 390; i++) {
      const start = open + i * 60;
      const burst =
        date === "2026-06-03" &&
        start >= Date.parse("2026-06-03T14:00:00Z") / 1000 &&
        start < Date.parse("2026-06-03T14:05:00Z") / 1000;
      // The burst climbs 1.00 a minute in green candles: 100 → 101 … → 105.
      const step = (start - Date.parse("2026-06-03T14:00:00Z") / 1000) / 60;
      rows.push({
        start,
        open: burst ? 100 + step : 100,
        high: burst ? 101 + step : 100,
        low: burst ? 100 + step : 100,
        close: burst ? 101 + step : 100,
        volume: burst ? 20000 : 1000,
      });
    }
  }
  return rows;
}
const later = Date.parse("2026-07-01T00:00:00Z");

test("backtest reconstructs the alerts the live collector would have sent", async () => {
  const requests: string[][] = [];
  const result = await runBacktest(
    // v3 candles keep this fixture's timing; v4 is checked below.
    { tickers: ["AAPL"], from, to, config: { directionBars: 3 } },
    async (ticker, start, end) => {
      requests.push([ticker, start, end]);
      return syntheticBars();
    },
    later,
  );
  assert.deepEqual(requests, [
    ["AAPL", `${sessions[0]}T00:00:00Z`, "2026-06-06T06:00:00.000Z"],
    // SPY minute bars from the first warmup session: alert context and the
    // look-now score's market-adjusted normal moves.
    ["SPY", `${sessions[0]}T00:00:00Z`, "2026-06-06T06:00:00.000Z"],
  ]);
  assert.equal(result.alerts.length, 1);
  const [alert] = result.alerts;
  assert.equal(alert?.ticker, "AAPL");
  // The first burst minute already lifts the 5-minute window to 4.8×.
  // Bars 14:00–14:02 (window ending 14:03Z) rise 100 → 103 in green candles.
  assert.equal(alert?.end, "2026-06-03T14:03:00.000Z");
  assert.equal(alert?.actual, 60000);
  // v4's single candle fires on the first burst window, two minutes earlier.
  const v4 = await runBacktest(
    { tickers: ["AAPL"], from, to },
    async () => syntheticBars(),
    later,
  );
  assert.equal(v4.alerts[0]?.end, "2026-06-03T14:01:00.000Z");
  assert.equal(v4.alerts[0]?.rule, "rvol-v5");
  assert.equal(alert?.expected, 3000);
  assert.equal(alert?.direction, "up");
  assert.equal(alert?.close, 103);
  // No daily bars, so no beta: the alert carries no market context.
  assert.equal(alert?.context, null);
  // Windows ending 14:04 and 14:05 are still rising: no repeat alert. Later
  // windows include a flat 100 bar and break the direction.
  assert.equal(result.diagnostics.suppressed, 2);
  // Only in-range windows are counted: 5 sessions × 387 (window + prior bar).
  assert.equal(result.evaluated, 5 * 387);
  assert.deepEqual(result.coverage, [
    { ticker: "AAPL", bars: 5 * 390, missingSessions: [] },
  ]);
});

test("a missing session is reported and blocks baselines that need it", async () => {
  const result = await runBacktest(
    { tickers: ["AAPL"], from, to },
    async () => syntheticBars(["2026-06-02"]),
    later,
  );
  assert.deepEqual(result.coverage[0]?.missingSessions, ["2026-06-02"]);
  // Every session after the gap has the missing date in its baseline.
  assert.equal(result.alerts.length, 0);
  assert.equal(result.diagnostics["insufficient-history"], 3 * 387);
});

test("with a 15-minute SIP delay the most recent 15 minutes are never requested or used", async () => {
  const now = Date.parse("2026-06-03T14:10:00Z");
  let requestedEnd = "";
  const result = await runBacktest(
    { tickers: ["AAPL"], from, to },
    async (_ticker, _start, end) => {
      requestedEnd = end;
      return syntheticBars();
    },
    now,
    undefined,
    undefined,
    15,
  );
  assert.equal(requestedEnd, "2026-06-03T13:55:00.000Z");
  assert.equal(result.alerts.length, 0);
  assert.deepEqual(result.coverage[0]?.missingSessions, []);
});

test("backtest rejects invalid tickers, ranges and configuration", async () => {
  const history = async () => [];
  for (const input of [
    null,
    { tickers: [], from, to },
    { tickers: ["aapl"], from, to },
    { tickers: ["AAPL", "AAPL"], from, to },
    { tickers: Array.from({ length: 11 }, (_, i) => `T${i}`), from, to },
    { tickers: ["AAPL"], from: to, to: from },
    // Warmup before early 2024 falls outside calendar coverage (2024–2028).
    { tickers: ["AAPL"], from: "2024-01-08", to: "2024-01-09" },
    // Over 50 sessions.
    { tickers: ["AAPL"], from: "2026-03-02", to: "2026-07-15" },
    // Over the memory budget: 19 sessions fit 4 symbols per request.
    {
      tickers: ["AAPL", "MSFT", "NVDA", "AMZN", "META"],
      from: "2026-05-04",
      to: "2026-05-29",
    },
    // A long warmup leaves no room for even one symbol.
    {
      tickers: ["AAPL"],
      from: "2026-06-01",
      to: "2026-07-31",
      config: { days: 60 },
    },
    { tickers: ["AAPL"], from: "2026-06-06", to: "2026-06-07" },
    { tickers: ["AAPL"], from, to, config: { threshold: 1 } },
  ]) {
    const response = await handleBacktest(
      input,
      { key: "key", secret: "secret" },
      (async () => {
        throw new Error("no request expected");
      }) as typeof fetch,
      later,
    );
    assert.equal(response.status, 400, JSON.stringify(input));
  }
  await assert.rejects(
    runBacktest({ tickers: ["AAPL"], from: "2026-12-01", to }, history, later),
  );
});

test("cached per-symbol parts rebuild the same result as runBacktest", async () => {
  const history = async (ticker: string) =>
    ticker === "SPY" ? [] : syntheticBars();
  // v3 candles keep this fixture's timing (see above).
  const input = {
    tickers: ["AAPL", "MSFT"],
    from,
    to,
    config: { directionBars: 3 },
  };
  const direct = await runBacktest(input, history, later);
  const request = parseBacktest(input, later, false);
  const window = backtestWindow(request, later);
  const run = new BacktestRun(request, window, [], []);
  for (const ticker of request.tickers)
    run.merge(
      decodePart(encodePart(run.compute(ticker, await history(ticker), []))),
    );
  assert.ok(direct.alerts.length > 0);
  assert.deepEqual(run.finish(), direct);
  // NaN (a horizon a random minute could not measure) survives the round trip.
  const part = run.compute("AAPL", await history("AAPL"), []);
  part.randoms[0]![0] = NaN;
  assert.ok(Number.isNaN(decodePart(encodePart(part)).randoms[0]![0]));
});

test("backtest symbols per request shrink as the range grows", () => {
  // Calibrated so 4 symbols × 20 sessions is the largest 20-session request.
  assert.equal(maxSymbolsPerRequest(1, 20), 10);
  assert.equal(maxSymbolsPerRequest(20, 20), 4);
  assert.equal(maxSymbolsPerRequest(23, 20), 3);
  assert.equal(maxSymbolsPerRequest(30, 20), 2);
  assert.equal(maxSymbolsPerRequest(40, 20), 1);
  assert.equal(maxSymbolsPerRequest(50, 20), 1);
  assert.equal(maxSymbolsPerRequest(51, 20), 0);
  // A longer warmup costs like a longer range.
  assert.equal(maxSymbolsPerRequest(20, 60), 0);
});

test("local API and hosted Worker share the backtest contract", async () => {
  const pages: string[] = [];
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    pages.push(url.searchParams.get("feed") ?? "");
    return url.pathname.includes("FAIL")
      ? new Response("secret-bearing body", { status: 403 })
      : Response.json({ bars: [], next_page_token: null });
  }) as typeof fetch;
  const app = buildApp(false, { key: "key", secret: "secret", fetcher });
  const unconfigured = buildApp(false, {});
  try {
    const ok = await app.inject({
      method: "POST",
      url: "/api/backtest",
      payload: { tickers: ["AAPL"], from, to },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().source, "alpaca");
    // No bars: the requested symbol is still listed, with zero baseline.
    assert.deepEqual(ok.json().validation.baselineBySymbol, {
      AAPL: { scored: 0, good: 0, stopped: 0, weak: 0 },
    });
    // AAPL and SPY minute bars, then AAPL and SPY daily bars for beta.
    assert.deepEqual(pages, ["sip", "sip", "sip", "sip"]);

    const failed = await app.inject({
      method: "POST",
      url: "/api/backtest",
      payload: { tickers: ["FAIL"], from, to },
    });
    assert.equal(failed.statusCode, 502);
    assert.deepEqual(failed.json(), {
      error: "Alpaca REST request failed (403)",
    });

    const local = await unconfigured.inject({
      method: "POST",
      url: "/api/backtest",
      payload: { tickers: ["AAPL"], from, to },
    });
    const hosted = await worker.fetch(
      new Request("https://example.test/api/backtest", {
        method: "POST",
        body: JSON.stringify({ tickers: ["AAPL"], from, to }),
      }),
    );
    assert.equal(local.statusCode, 503);
    assert.equal(hosted.status, 503);
    assert.deepEqual(await hosted.json(), local.json());
    for (const [body, status] of [
      ["{", 400],
      [" ".repeat(65537), 413],
    ] as const) {
      const r = await worker.fetch(
        new Request("https://example.test/api/backtest", {
          method: "POST",
          body,
        }),
      );
      assert.equal(r.status, status);
    }
  } finally {
    await app.close();
    await unconfigured.close();
  }
});

test("alerts carry the move against SPY scaled by the ticker's beta", async () => {
  // SPY flat at 500, 501 at the alert minute (+0.2%); AAPL +5% at the alert.
  const spyMinutes = syntheticBars().map((b) => {
    // 501 at the alert minute (bar 14:02Z), 500 otherwise.
    const close =
      b.start === Date.parse("2026-06-03T14:02:00Z") / 1000 ? 501 : 500;
    return { ...b, open: close, high: close, low: close, close };
  });
  const days = previousSessions("2026-06-05", 70);
  const moves = days.map((_, i) => ((i * 7) % 5) / 500 - 0.004);
  const daily = (scale: number, base: number): RawBar[] => {
    let close = base;
    return days.map((d, i) => {
      if (i) close *= 1 + scale * moves[i]!;
      // Midday UTC falls on the same New York date in both EST and EDT.
      const start = Date.parse(`${d}T12:00:00Z`) / 1000;
      return { start, open: close, high: close, low: close, close, volume: 1 };
    });
  };
  const result = await runBacktest(
    // v3 candles keep this fixture's timing; v4 is checked below.
    { tickers: ["AAPL"], from, to, config: { directionBars: 3 } },
    async (ticker) => (ticker === "SPY" ? spyMinutes : syntheticBars()),
    later,
    async (ticker, _start, end) => {
      assert.equal(end, `${to}T00:00:00Z`);
      return ticker === "SPY" ? daily(1, 500) : daily(1.5, 200);
    },
  );
  const context = result.alerts[0]?.context;
  assert.ok(context);
  assert.ok(Math.abs(context.beta - 1.5) < 1e-9);
  assert.ok(Math.abs(context.change - 3) < 1e-9);
  assert.ok(Math.abs(context.spyChange - 0.2) < 1e-9);
  assert.ok(Math.abs(context.excess - 2.7) < 1e-9);
});

test("backtest alerts carry the marked-sections score vs SPY at the alert's E", async () => {
  // SYNTHETIC: SPY flat at 500 with a one-minute dip to 497.5 (−0.5 %) at
  // 09:50 New York on every other session (even index), the alert day
  // 2026-06-03 included; AAPL is flat at 100 apart from its burst. The alert
  // bar starts 10:02 (window 3) → E = 09:59: the green mark at 09:50 has
  // age 9, w = 51/60, c = 0.5 β.
  const dipAt = (date: string) => Date.parse(`${date}T13:50:00Z`) / 1000;
  const spyMinutes = syntheticBars().map((b) => {
    const date = new Date(b.start * 1000).toISOString().slice(0, 10);
    const level =
      sessions.indexOf(date) % 2 === 0 && b.start === dipAt(date) ? 497.5 : 500;
    return { ...b, open: level, high: level, low: level, close: level };
  });
  const daily = pairedDaily(0.01, previousSessions("2026-06-05", 70));
  const result = await runBacktest(
    { tickers: ["AAPL"], from, to, config: { directionBars: 3 } },
    async (ticker) => (ticker === "SPY" ? spyMinutes : syntheticBars()),
    later,
    async (ticker) => (ticker === "SPY" ? daily.benchmark : daily.stock),
  );
  const alert = result.alerts[0]!;
  assert.equal(alert.end, "2026-06-03T14:03:00.000Z");
  // σ at 09:59: I is the same on the 10 dip sessions of the previous 20 and
  // 0 on the others → σ = I / √2.
  const expected = (beta: number) => {
    const sum = (0.5 * beta * 51) / 60;
    const sigma = Number((sum / Math.SQRT2).toPrecision(4));
    return { sum, score: marksScore(sum, sigma) };
  };
  const vs = alert.vsSpy!;
  assert.ok(Math.abs(vs.sum! - expected(1.5).sum) < 1e-4);
  assert.ok(Math.abs(vs.beta - 1.5) < 1e-9);
  assert.equal(vs.betaAssumed, false);
  assert.equal(vs.spyLagged, false);
  assert.equal(vs.score, expected(1.5).score);
  assert.equal(vs.score, 92); // round(100 · Φ(√2))
  assert.equal(vs.label, undefined);
  assert.equal(vs.area, undefined);
  // Without daily bars: β 1 assumed; σ still comes from minute bars.
  const bare = await runBacktest(
    { tickers: ["AAPL"], from, to, config: { directionBars: 3 } },
    async (ticker) => (ticker === "SPY" ? spyMinutes : syntheticBars()),
    later,
  );
  const plain = bare.alerts[0]!.vsSpy!;
  assert.equal(plain.betaAssumed, true);
  assert.equal(plain.beta, 1);
  assert.ok(Math.abs(plain.sum! - expected(1).sum) < 1e-4);
  assert.equal(plain.score, 92);
  // SPY's own alerts are never scored against SPY.
  const spyRun = await runBacktest(
    { tickers: ["SPY"], from, to, config: { directionBars: 3 } },
    async () => syntheticBars(),
    later,
  );
  assert.equal(spyRun.alerts[0]!.vsSpy!.score, null);
});

// Synthetic zigzag bars: every minute's close differs from three minutes
// earlier and fifteen minutes later, so every fifth regular minute in range
// is a scored baseline entry. `period` changes the pattern per symbol.
function zigzagBars(period: number): RawBar[] {
  return syntheticBars().map((b, i) => {
    const close = 100 + (((i * 3) % period) - period / 2) * 0.05;
    const open = 100 + ((((i - 1) * 3) % period) - period / 2) * 0.05;
    return {
      ...b,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume: 1000,
    };
  });
}

test("the baseline is also split by symbol and the split sums to the total", async () => {
  const bars: Record<string, RawBar[]> = {
    AAPL: zigzagBars(11),
    MSFT: zigzagBars(7),
    FLAT: syntheticBars(), // flat at 100: no baseline entries
  };
  const history = async (ticker: string) => bars[ticker] ?? syntheticBars();
  const result = await runBacktest(
    { tickers: ["AAPL", "MSFT", "FLAT"], from, to },
    history,
    later,
  );
  const { baseline, baselineBySymbol } = result.validation;
  assert.ok(baselineBySymbol);
  assert.deepEqual(Object.keys(baselineBySymbol), ["AAPL", "MSFT", "FLAT"]);
  // A symbol without scored baseline entries is present with zeros.
  assert.deepEqual(baselineBySymbol.FLAT, {
    scored: 0,
    good: 0,
    stopped: 0,
    weak: 0,
  });
  for (const k of ["scored", "good", "stopped", "weak"] as const)
    assert.equal(
      Object.values(baselineBySymbol).reduce((n, c) => n + c[k], 0),
      baseline[k],
      k,
    );
  // Each symbol's counts are exactly its own baseline from a solo run.
  for (const ticker of ["AAPL", "MSFT"]) {
    const counts: BaselineCounts = baselineBySymbol[ticker]!;
    assert.ok(counts.scored > 0, ticker);
    assert.equal(counts.good + counts.stopped + counts.weak, counts.scored);
    const solo = await runBacktest(
      { tickers: [ticker], from, to },
      history,
      later,
    );
    assert.deepEqual(counts, solo.validation.baseline, ticker);
  }
  assert.notDeepEqual(baselineBySymbol.AAPL, baselineBySymbol.MSFT);
  // Additive: older clients see the same fields, plus the new map.
  assert.deepEqual(Object.keys(result.validation).sort(), [
    "baseline",
    "baselineBySymbol",
    "config",
    "good",
    "medianForward",
    "medianMinutesToGood",
    "medianRunUnits",
    "scored",
    "stopped",
    "unscored",
    "weak",
  ]);
});

test("local API and hosted Worker return the same per-symbol baseline", async () => {
  // Fake Alpaca serving the zigzag fixture for every symbol; placeholder keys.
  const fixture = zigzagBars(11);
  const fake = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    const minute = url.searchParams.get("timeframe") === "1Min";
    return Response.json({
      bars: minute
        ? fixture.map((b) => ({
            t: new Date(b.start * 1000).toISOString(),
            o: b.open,
            h: b.high,
            l: b.low,
            c: b.close,
            v: b.volume,
          }))
        : [],
      next_page_token: null,
    });
  }) as typeof fetch;
  const payload = { tickers: ["AAPL", "MSFT"], from, to };
  const app = buildApp(false, { key: "key", secret: "secret", fetcher: fake });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    const local = await app.inject({
      method: "POST",
      url: "/api/backtest",
      payload,
    });
    const hosted = await worker.fetch(
      new Request("https://example.test/api/backtest", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
      { ALPACA_API_KEY: "key", ALPACA_API_SECRET: "secret" },
    );
    assert.equal(local.statusCode, 200);
    assert.equal(hosted.status, 200);
    const a = local.json().validation;
    const b = (await hosted.json()).validation;
    assert.ok(a.baselineBySymbol.AAPL.scored > 0);
    assert.deepEqual(a.baselineBySymbol, b.baselineBySymbol);
    assert.deepEqual(a.baseline, b.baseline);
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
  }
});

test("the result cache serves computed symbols on the next run", async () => {
  const requests: string[] = [];
  const history = async (ticker: string) => {
    requests.push(ticker);
    return ticker === "SPY" ? [] : syntheticBars();
  };
  const input = {
    tickers: ["AAPL", "MSFT"],
    from,
    to,
    config: { directionBars: 3 },
  };
  const plain = await runBacktest(input, history, later);
  const results = new ResultCache(new SqliteD1(":memory:"), "code-1");
  requests.length = 0;
  const first = await runBacktest(input, history, later, undefined, results);
  assert.deepEqual(first.results, { hits: 0, misses: 2 });
  assert.deepEqual(requests, ["AAPL", "MSFT", "SPY"]);
  requests.length = 0;
  const second = await runBacktest(input, history, later, undefined, results);
  assert.deepEqual(second.results, { hits: 2, misses: 0 });
  assert.deepEqual(requests, [], "no bars are read for cached symbols");
  const { results: _a, ...firstResult } = first;
  const { results: _b, ...secondResult } = second;
  assert.deepEqual(firstResult, plain);
  assert.deepEqual(secondResult, plain);
  // Another code version, setting or symbol is a different key.
  const other = new ResultCache(new SqliteD1(":memory:"), "code-2");
  const third = await runBacktest(input, history, later, undefined, other);
  assert.deepEqual(third.results, { hits: 0, misses: 2 });
  const changed = await runBacktest(
    { ...input, config: { directionBars: 2 } },
    history,
    later,
    undefined,
    results,
  );
  assert.deepEqual(changed.results, { hits: 0, misses: 2 });
});

test("a range whose last day is not final is never cached", async () => {
  const results = new ResultCache(new SqliteD1(":memory:"), "code-1");
  const history = async (ticker: string) =>
    ticker === "SPY" ? [] : syntheticBars();
  // 2026-06-05 18:00Z: the range's last session is still trading.
  const during = Date.parse("2026-06-05T18:00:00Z");
  const input = { tickers: ["AAPL"], from, to };
  const result = await runBacktest(input, history, during, undefined, results);
  assert.equal(result.results, undefined);
  const after = await runBacktest(input, history, later, undefined, results);
  assert.deepEqual(after.results, { hits: 0, misses: 1 });
});

test("values larger than one D1 statement are split into rows", async () => {
  const db = new SqliteD1(":memory:");
  const blobs = new D1Blobs(db, "blobs", ["label"]);
  // Incompressible text: about 3 rows of base64 after gzip.
  let text = "";
  let x = 7;
  for (let i = 0; i < 200_000; i++) {
    x = (x * 48271) % 2147483647;
    text += String.fromCharCode(33 + (x % 90));
  }
  await blobs.put([{ key: "k", meta: { label: "big" }, text }]);
  const { results: rows } = await db
    .prepare("SELECT chunk, chunks, label FROM blobs ORDER BY chunk")
    .all<{ chunk: number; chunks: number; label: string }>();
  assert.ok(rows.length >= 2, `${rows.length} rows`);
  assert.ok(rows.every((r) => r.chunks === rows.length && r.label === "big"));
  assert.equal((await blobs.get(["k", "missing"])).get("k"), text);
  assert.equal((await blobs.get(["k", "missing"])).has("missing"), false);
  // A partly written value counts as missing.
  await db.prepare("DELETE FROM blobs WHERE chunk = 1").run();
  assert.equal((await blobs.get(["k"])).has("k"), false);
});
