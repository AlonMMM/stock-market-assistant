import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../apps/api/src/app.js";
import worker from "../apps/api/src/worker.js";
import {
  handleBacktest,
  runBacktest,
} from "../packages/market-data/src/backtest.js";
import type { RawBar } from "../packages/market-data/src/bars.js";
import { previousSessions } from "../packages/market-data/src/calendar.js";

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
    { tickers: ["AAPL"], from, to },
    async (ticker, start, end) => {
      requests.push([ticker, start, end]);
      return syntheticBars();
    },
    later,
  );
  assert.deepEqual(requests, [
    ["AAPL", `${sessions[0]}T00:00:00Z`, "2026-06-06T06:00:00.000Z"],
    // SPY minute bars from the last warmup session, for alert context.
    ["SPY", "2026-05-29T00:00:00Z", "2026-06-06T06:00:00.000Z"],
  ]);
  assert.equal(result.alerts.length, 1);
  const [alert] = result.alerts;
  assert.equal(alert?.ticker, "AAPL");
  // The first burst minute already lifts the 5-minute window to 4.8×.
  // Bars 14:00–14:02 (window ending 14:03Z) rise 100 → 103 in green candles.
  assert.equal(alert?.end, "2026-06-03T14:03:00.000Z");
  assert.equal(alert?.actual, 60000);
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

test("the most recent 15 minutes of SIP data are never requested or used", async () => {
  const now = Date.parse("2026-06-03T14:10:00Z");
  let requestedEnd = "";
  const result = await runBacktest(
    { tickers: ["AAPL"], from, to },
    async (_ticker, _start, end) => {
      requestedEnd = end;
      return syntheticBars();
    },
    now,
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
    { tickers: ["AAPL"], from: "2026-01-05", to: "2026-01-06" },
    { tickers: ["AAPL"], from: "2026-06-01", to: "2026-07-15" },
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
    { tickers: ["AAPL"], from, to },
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
