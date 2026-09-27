import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../apps/api/src/app.js";
import worker from "../apps/api/src/worker.js";
import {
  dailyBeta,
  handleDayChart,
  runDayChart,
} from "../packages/market-data/src/day-chart.js";
import {
  newYork,
  previousSessions,
} from "../packages/market-data/src/calendar.js";
import type { RawBar } from "../packages/market-data/src/bars.js";

// Synthetic bars on Tue 2026-06-02 (EDT) and the previous session, Mon 06-01:
// one pre-market, two regular and one after-hours minute per day.
function bars(price: number): RawBar[] {
  const rows: RawBar[] = [];
  for (const [date, offset] of [
    ["2026-06-01", 0],
    ["2026-06-02", 1],
  ] as const)
    for (const time of ["12:00", "13:30", "19:59", "21:00"]) {
      const close = price + offset + (time === "19:59" ? 0.5 : 0);
      rows.push({
        start: Date.parse(`${date}T${time}:00Z`) / 1000,
        open: close,
        high: close,
        low: close,
        close,
        volume: 100,
      });
    }
  return rows;
}
const later = Date.parse("2026-07-01T00:00:00Z");

test("day chart returns the ticker then SPY with previous regular closes", async () => {
  const requests: string[][] = [];
  const result = await runDayChart(
    { ticker: "AAPL", date: "2026-06-02" },
    async (ticker, start, end) => {
      requests.push([ticker, start, end]);
      return bars(ticker === "SPY" ? 500 : 200);
    },
    later,
  );
  assert.deepEqual(requests, [
    ["AAPL", "2026-06-01T00:00:00Z", "2026-06-03T06:00:00.000Z"],
    ["SPY", "2026-06-01T00:00:00Z", "2026-06-03T06:00:00.000Z"],
  ]);
  assert.deepEqual(
    result.series.map((s) => [s.ticker, s.previousClose]),
    [
      ["AAPL", 200.5],
      ["SPY", 500.5],
    ],
  );
  assert.deepEqual(result.series[0]!.bars, [
    {
      start: Date.parse("2026-06-02T12:00:00Z") / 1000,
      session: "pre",
      open: 201,
      close: 201,
      volume: 100,
    },
    {
      start: Date.parse("2026-06-02T13:30:00Z") / 1000,
      session: "regular",
      open: 201,
      close: 201,
      volume: 100,
    },
    {
      start: Date.parse("2026-06-02T19:59:00Z") / 1000,
      session: "regular",
      open: 201.5,
      close: 201.5,
      volume: 100,
    },
    {
      start: Date.parse("2026-06-02T21:00:00Z") / 1000,
      session: "post",
      open: 201,
      close: 201,
      volume: 100,
    },
  ]);
});

test("day chart for SPY itself has one series; missing previous day is null", async () => {
  const result = await runDayChart(
    { ticker: "SPY", date: "2026-06-02" },
    async () => bars(500).slice(4),
    later,
  );
  assert.equal(result.series.length, 1);
  assert.equal(result.series[0]!.previousClose, null);
  assert.equal(result.series[0]!.bars.length, 4);
});

test("day chart never requests the most recent 15 minutes", async () => {
  const now = Date.parse("2026-06-02T15:00:00Z");
  let requestedEnd = "";
  await runDayChart(
    { ticker: "AAPL", date: "2026-06-02" },
    async (_ticker, _start, end) => {
      requestedEnd = end;
      return [];
    },
    now,
  );
  assert.equal(requestedEnd, "2026-06-02T14:45:00.000Z");
});

test("day chart rejects invalid symbols and non-trading days", async () => {
  for (const input of [
    null,
    { ticker: "aapl", date: "2026-06-02" },
    { ticker: "AAPL", date: "2026-06-06" },
    { ticker: "AAPL", date: "2025-06-02" },
    { ticker: "AAPL", date: "2026-06-02T00:00" },
    { ticker: "AAPL", date: "2026-01-02" },
  ]) {
    const response = await handleDayChart(
      input,
      { key: "key", secret: "secret" },
      (async () => {
        throw new Error("no request expected");
      }) as typeof fetch,
      later,
    );
    assert.equal(response.status, 400, JSON.stringify(input));
  }
});

test("local API and hosted Worker share the day chart contract", async () => {
  const fetcher = (async (input: URL | RequestInfo) =>
    new URL(String(input)).pathname.includes("FAIL")
      ? new Response("secret-bearing body", { status: 403 })
      : Response.json({ bars: [], next_page_token: null })) as typeof fetch;
  const app = buildApp(false, { key: "key", secret: "secret", fetcher });
  const unconfigured = buildApp(false, {});
  const payload = { ticker: "AAPL", date: "2026-06-02" };
  try {
    const ok = await app.inject({
      method: "POST",
      url: "/api/day-chart",
      payload,
    });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(
      ok.json().series.map((s: { ticker: string }) => s.ticker),
      ["AAPL", "SPY"],
    );
    const failed = await app.inject({
      method: "POST",
      url: "/api/day-chart",
      payload: { ...payload, ticker: "FAIL" },
    });
    assert.equal(failed.statusCode, 502);
    assert.deepEqual(failed.json(), {
      error: "Alpaca REST request failed (403)",
    });
    const local = await unconfigured.inject({
      method: "POST",
      url: "/api/day-chart",
      payload,
    });
    const hosted = await worker.fetch(
      new Request("https://example.test/api/day-chart", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
    assert.equal(hosted.status, 503);
    assert.deepEqual(await hosted.json(), local.json());
  } finally {
    await app.close();
    await unconfigured.close();
  }
});

// Daily bars stamped at New York midnight, as Alpaca returns them
// (04:00Z in daylight time, 05:00Z in standard time).
function daily(sessions: string[], close: (i: number) => number): RawBar[] {
  return sessions.map((d, i) => {
    const c = close(i);
    const edt = Date.parse(`${d}T04:00:00Z`);
    return {
      start: (newYork(edt).date === d ? edt : edt + 3600000) / 1000,
      open: c,
      high: c,
      low: c,
      close: c,
      volume: 1,
    };
  });
}
const betaSessions = previousSessions("2026-06-02", 61);
const spyMoves = betaSessions.map((_, i) => ((i * 7) % 5) / 500 - 0.004);
const spyClose = (i: number) =>
  spyMoves.slice(1, i + 1).reduce((c, r) => c * (1 + r), 500);
// Ticker return is exactly 1.5x SPY's every day, plus a constant drift.
const tickerClose = (i: number) =>
  spyMoves.slice(1, i + 1).reduce((c, r) => c * (1 + 1.5 * r + 0.001), 200);

test("beta is the slope of daily ticker returns on SPY returns", () => {
  const beta = dailyBeta(
    betaSessions,
    daily(betaSessions, tickerClose),
    daily(betaSessions, spyClose),
  );
  assert.equal(beta.returns, 60);
  assert.ok(Math.abs(beta.value! - 1.5) < 1e-9, String(beta.value));
  // Fewer than 40 paired returns (a gap every other day) is unavailable.
  const sparse = betaSessions.filter((_, i) => i % 2 === 0);
  assert.equal(
    dailyBeta(betaSessions, daily(sparse, tickerClose), daily(sparse, spyClose))
      .value,
    null,
  );
});

test("day chart beta uses only sessions before the chart day", async () => {
  const requests: string[][] = [];
  const result = await runDayChart(
    { ticker: "AAPL", date: "2026-06-02" },
    async () => [],
    later,
    async (ticker, start, end) => {
      requests.push([ticker, start, end]);
      return daily(betaSessions, ticker === "SPY" ? spyClose : tickerClose);
    },
  );
  assert.deepEqual(requests, [
    ["AAPL", `${betaSessions[0]}T00:00:00Z`, "2026-06-02T00:00:00Z"],
    ["SPY", `${betaSessions[0]}T00:00:00Z`, "2026-06-02T00:00:00Z"],
  ]);
  assert.ok(Math.abs(result.beta.value! - 1.5) < 1e-9);
  assert.equal(result.beta.lookback, 60);
  // SPY has no beta against itself; early 2026 lacks calendar coverage.
  for (const input of [
    { ticker: "SPY", date: "2026-06-02" },
    { ticker: "AAPL", date: "2026-01-05" },
  ]) {
    const r = await runDayChart(
      input,
      async () => [],
      later,
      async () => {
        throw new Error("no daily request expected");
      },
    );
    assert.equal(r.beta.value, null, JSON.stringify(input));
  }
});

test("day chart compares with a requested sector benchmark instead of SPY", async () => {
  const minute: string[] = [];
  const daily: string[] = [];
  const result = await runDayChart(
    { ticker: "MSTR", date: "2026-06-02", benchmark: "IBIT" },
    async (ticker) => {
      minute.push(ticker);
      return [];
    },
    later,
    async (ticker) => {
      daily.push(ticker);
      return [];
    },
  );
  assert.deepEqual(minute, ["MSTR", "IBIT"]);
  assert.deepEqual(daily, ["MSTR", "IBIT"]);
  assert.deepEqual(
    result.series.map((s) => s.ticker),
    ["MSTR", "IBIT"],
  );
  await assert.rejects(
    runDayChart(
      { ticker: "MSTR", date: "2026-06-02", benchmark: "btc" },
      async () => [],
      later,
    ),
    /benchmark/,
  );
});
