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
import { newYorkToUtc } from "../packages/market-data/src/calendar.js";
import { MemoryDailyStore } from "../packages/market-data/src/volume-baseline.js";
import type { MarksSigma } from "../packages/market-data/src/marks-vs-spy.js";

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
    // The ticker reaches back 20 sessions for its typical volume.
    ["AAPL", "2026-05-04T00:00:00Z", "2026-06-03T06:00:00.000Z"],
    ["SPY", "2026-06-01T00:00:00Z", "2026-06-03T06:00:00.000Z"],
    // SPY's previous 20 sessions (New York midnights) for the area σ.
    ["SPY", "2026-05-04T04:00:00.000Z", "2026-06-02T04:00:00.000Z"],
  ]);
  assert.equal(result.series[1]!.typicalVolume, undefined);
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

test("day chart requests up to now, or up to the configured SIP delay", async () => {
  const now = Date.parse("2026-06-02T15:00:00Z");
  const requested = async (delayMinutes?: number) => {
    let requestedEnd = "";
    const chart = await runDayChart(
      { ticker: "AAPL", date: "2026-06-02" },
      async (_ticker, _start, end) => {
        requestedEnd ||= end; // the chart's own request comes first
        return [];
      },
      now,
      undefined,
      delayMinutes,
    );
    return [requestedEnd, chart.delayMinutes];
  };
  // Scenario 8: real-time SIP (default 0) includes the latest minute.
  assert.deepEqual(await requested(), ["2026-06-02T15:00:00.000Z", 0]);
  assert.deepEqual(await requested(15), ["2026-06-02T14:45:00.000Z", 15]);
});

test("day chart rejects invalid symbols and non-trading days", async () => {
  for (const input of [
    null,
    { ticker: "aapl", date: "2026-06-02" },
    { ticker: "AAPL", date: "2026-06-06" },
    { ticker: "AAPL", date: "2023-06-02" },
    { ticker: "AAPL", date: "2026-06-02T00:00" },
    { ticker: "AAPL", date: "2024-01-02" },
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
  // SPY has no beta against itself; the 60 sessions before early 2024 lack
  // calendar coverage.
  for (const input of [
    { ticker: "SPY", date: "2026-06-02" },
    { ticker: "AAPL", date: "2024-01-05" },
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
  // SPY's minute and daily bars are added for the score vs SPY; the second
  // SPY minute request is its previous 20 sessions for the area σ.
  assert.deepEqual(minute, ["MSTR", "IBIT", "SPY", "SPY"]);
  assert.deepEqual(daily, ["MSTR", "IBIT", "SPY"]);
  assert.deepEqual(
    result.series.map((s) => s.ticker),
    ["MSTR", "IBIT"],
  );
  assert.equal(result.vsSpy?.spy?.ticker, "SPY");
  await assert.rejects(
    runDayChart(
      { ticker: "MSTR", date: "2026-06-02", benchmark: "btc" },
      async () => [],
      later,
    ),
    /benchmark/,
  );
});

// SYNTHETIC history: one pre-market (08:00 NY) and one regular (10:00 NY) bar
// per session; volume = 100 × (session index + 1), so medians are predictable.
function baselineBars(sessions: string[], date: string): RawBar[] {
  const rows: RawBar[] = [];
  sessions.forEach((d, i) => {
    for (const hour of [12, 14])
      rows.push({
        start: Date.parse(`${d}T${hour}:00:00Z`) / 1000,
        open: 10,
        high: 10,
        low: 10,
        close: 10,
        volume: 100 * (i + 1) + (hour === 12 ? 1 : 0),
      });
  });
  for (const time of ["12:00", "14:00", "14:01"])
    rows.push({
      start: Date.parse(`${date}T${time}:00Z`) / 1000,
      open: 10,
      high: 10,
      low: 10,
      close: 10,
      volume: 5,
    });
  return rows;
}

test("typical volume is the same-minute, same-session median over 20 sessions", async () => {
  const date = "2026-06-02";
  const sessions = previousSessions(date, 20);
  const result = await runDayChart(
    { ticker: "AAPL", date },
    async (ticker) => (ticker === "AAPL" ? baselineBars(sessions, date) : []),
    later,
  );
  const [aapl, spy] = result.series;
  // Volumes 100..2000 (+1 pre-market): median of 20 is 1050; 14:01 has none.
  assert.deepEqual(aapl!.typicalVolume, [1051, 1050, null]);
  assert.equal(aapl!.typicalVolume!.length, aapl!.bars.length);
  assert.equal(spy!.typicalVolume, undefined);
});

test("scenario 9: 10 of 20 prior sessions leaves typical volume null", async () => {
  const date = "2026-06-02";
  const sessions = previousSessions(date, 20);
  for (const [count, expected] of [
    [10, [null, null, null]],
    [14, [null, null, null]],
    // 15 sessions (the last 15, volumes 600..2000): median 1300.
    [15, [1301, 1300, null]],
  ] as const) {
    const rows = baselineBars(sessions, date).filter(
      (row) =>
        !sessions.slice(0, 20 - count).includes(newYork(row.start * 1000).date),
    );
    const result = await runDayChart(
      { ticker: "AAPL", date },
      async (ticker) => (ticker === "AAPL" ? rows : []),
      later,
    );
    assert.deepEqual(result.series[0]!.typicalVolume, expected);
  }
});

test("typical volume ignores the chart day and later days", async () => {
  const date = "2026-06-02";
  const sessions = previousSessions(date, 20);
  // Dates after the chart day in the response must not feed the baseline.
  const future = baselineBars(["2026-06-03", "2026-06-04"], "2026-06-05");
  const result = await runDayChart(
    { ticker: "AAPL", date },
    async (ticker) =>
      ticker === "AAPL" ? [...baselineBars(sessions, date), ...future] : [],
    later,
  );
  assert.deepEqual(result.series[0]!.typicalVolume, [1051, 1050, null]);
});

// SYNTHETIC: ticker returns are 1.5 × SPY's plus ±0.2% noise uncorrelated with
// SPY over every 4 sessions, so β vs SPY is 1.5 and the daily excess is ±0.2%.
const noise = [0.002, 0.002, -0.002, -0.002];
const noisyClose = (i: number) =>
  spyMoves
    .slice(1, i + 1)
    .reduce((c, r, k) => c * (1 + 1.5 * r + noise[k % 4]!), 200);
// A flat sector ETF: β vs it would be unavailable, β vs SPY is not.
const flatClose = () => 80;
const dailyFor = (ticker: string) =>
  daily(
    betaSessions,
    ticker === "SPY" ? spyClose : ticker === "XLK" ? flatClose : noisyClose,
  );

test("vsSpy carries β and σ against SPY", async () => {
  const result = await runDayChart(
    { ticker: "AAPL", date: "2026-06-02" },
    async (ticker) => bars(ticker === "SPY" ? 500 : 200),
    later,
    async (ticker) => dailyFor(ticker),
  );
  const vs = result.vsSpy!;
  assert.ok(Math.abs(vs.beta - 1.5) < 1e-6, String(vs.beta));
  assert.equal(vs.betaAssumed, false);
  assert.equal(vs.betaReturns, 60);
  // ±0.2% excess over the last 20 returns (5 full cycles of the pattern),
  // sample σ = 0.2 · √(20/19); the β fit is exact only up to rounding.
  assert.ok(Math.abs(vs.sigma! - 0.2 * Math.sqrt(20 / 19)) < 1e-3);
  // SPY is already a series: not repeated.
  assert.equal(vs.spy, undefined);
});

test("vsSpy is against SPY when the chart's benchmark is a sector ETF", async () => {
  const result = await runDayChart(
    { ticker: "AAPL", date: "2026-06-02", benchmark: "XLK" },
    async (ticker) =>
      bars(ticker === "SPY" ? 500 : ticker === "XLK" ? 80 : 200),
    later,
    async (ticker) => dailyFor(ticker),
  );
  // The chart's own β is vs XLK (flat: unavailable); vsSpy's is vs SPY.
  assert.equal(result.beta.value, null);
  assert.ok(Math.abs(result.vsSpy!.beta - 1.5) < 1e-6);
  const spy = result.vsSpy!.spy!;
  assert.equal(spy.ticker, "SPY");
  assert.equal(spy.previousClose, 500.5);
  assert.equal(spy.bars.length, 4);
  assert.equal(spy.typicalVolume, undefined);
});

test("vsSpy degrades to β assumed and no σ, never failing the chart", async () => {
  // SPY daily history fails while the sector benchmark's succeeds.
  const noSpyDaily = await runDayChart(
    { ticker: "AAPL", date: "2026-06-02", benchmark: "XLK" },
    async () => [],
    later,
    async (ticker) => {
      if (ticker === "SPY") throw new Error("Alpaca REST request failed (429)");
      return dailyFor(ticker);
    },
  );
  assert.deepEqual(
    { ...noSpyDaily.vsSpy, spy: undefined },
    { beta: 1, betaAssumed: true, betaReturns: 0, sigma: null, spy: undefined },
  );
  // Too little daily history: β assumed, σ null (14 returns < 15).
  const short = await runDayChart(
    { ticker: "AAPL", date: "2026-06-02" },
    async () => [],
    later,
    async (ticker) =>
      daily(betaSessions.slice(-15), ticker === "SPY" ? spyClose : noisyClose),
  );
  assert.equal(short.vsSpy!.betaAssumed, true);
  assert.equal(short.vsSpy!.beta, 1);
  assert.equal(short.vsSpy!.sigma, null);
  // SPY's minute bars fail with a sector benchmark: no vsSpy, chart still OK.
  const noSpyMinutes = await runDayChart(
    { ticker: "AAPL", date: "2026-06-02", benchmark: "XLK" },
    async (ticker) => {
      if (ticker === "SPY") throw new Error("Alpaca REST request failed (500)");
      return bars(200);
    },
    later,
    async (ticker) => dailyFor(ticker),
  );
  assert.equal(noSpyMinutes.vsSpy, undefined);
  assert.equal(noSpyMinutes.series.length, 2);
});

// SYNTHETIC minute bars for the marked-sections score: 09:30–10:40 NY each
// day; the stock is flat at 100; SPY is flat at 500 with a one-minute dip
// to 497.5 (−0.5 %) at 09:50 on even-index past days and on the chart day:
// a green mark with c = 0.5 (β 1). σ = I/√2 at every minute from 09:50 →
// score round(100 · Φ(√2)) = 92.
function marksRows(ticker: string, start: string, end: string): RawBar[] {
  const chartDay = "2026-06-02";
  const days = [...previousSessions(chartDay, 20), chartDay];
  return days.flatMap((d, index) =>
    Array.from({ length: 71 }, (_, i) => {
      const level =
        ticker === "SPY" ? (index % 2 === 0 && i === 20 ? 497.5 : 500) : 100;
      return {
        start: newYorkToUtc(d, 570 + i) / 1000,
        open: level,
        high: level,
        low: level,
        close: level,
        volume: 100,
      };
    }).filter(
      (r) =>
        r.start * 1000 >= Date.parse(start) && r.start * 1000 < Date.parse(end),
    ),
  );
}

test("marksVsSpy: contributions, sums and scores per minute, σ curve stored", async () => {
  const sigmas = new MemoryDailyStore<MarksSigma>();
  const requests: string[] = [];
  const chart = () =>
    runDayChart(
      { ticker: "AAPL", date: "2026-06-02" },
      async (ticker, start, end) => {
        requests.push(ticker);
        return marksRows(ticker, start, end);
      },
      later,
      undefined,
      undefined,
      sigmas,
    );
  const result = await chart();
  const marks = result.marksVsSpy!;
  assert.equal(result.areaVsSpy, undefined);
  assert.equal(marks.start, Date.parse("2026-06-02T13:30:00Z") / 1000);
  for (const key of ["contribution", "mark", "sum", "sigma", "score"] as const)
    assert.equal(marks[key].length, 71, key);
  assert.deepEqual(
    marks.contribution.flatMap((c, k) => (c === null ? [] : [[k, c]])),
    [[20, 0.5]],
  );
  assert.equal(marks.mark[20], "strong");
  // σ = 0 before the first mark of any session: no score yet.
  assert.ok(marks.score.slice(0, 20).every((s) => s === null));
  assert.equal(marks.score[20], 92);
  assert.equal(marks.score.at(-1), 92);
  assert.ok(Math.abs(marks.sum.at(-1)! - (0.5 * 10) / 60) < 1e-4);
  assert.equal(
    marks.sigma.at(-1),
    Number(((0.5 * 10) / 60 / Math.SQRT2).toPrecision(4)),
  );
  // No daily bars: β 1 assumed, flagged.
  assert.equal(marks.beta, 1);
  assert.equal(marks.betaAssumed, true);
  assert.deepEqual(requests, ["AAPL", "SPY", "SPY"]);
  assert.equal(sigmas.rows.size, 1);
  // The stored curve is reused: no 20-session SPY request.
  requests.length = 0;
  assert.deepEqual((await chart()).marksVsSpy, marks);
  assert.deepEqual(requests, ["AAPL", "SPY"]);
  // SPY itself has no series.
  const spy = await runDayChart(
    { ticker: "SPY", date: "2026-06-02" },
    async (ticker, start, end) => marksRows(ticker, start, end),
    later,
  );
  assert.equal(spy.marksVsSpy, undefined);
});
