import assert from "node:assert/strict";
import test from "node:test";
import {
  coreClose,
  newYorkToUtc,
} from "../packages/market-data/src/calendar.js";
import {
  handleChartBars,
  volumeRank,
} from "../packages/market-data/src/chart-bars.js";

// Synthetic bars generated for whatever range is asked. Every regular bar of
// m minutes has 1000 × m shares, except the first bar of Friday 2026-10-16,
// which has twice that; a pre-market bar at 08:00 is always there to be
// ignored. Prices rise by a cent a bar; the bar VWAP is its close.
const credentials = { key: "k", secret: "s", sipDelayMinutes: 0 };
const friday = "2026-10-16";
const minutes: Record<string, number> = {
  "1Min": 1,
  "5Min": 5,
  "15Min": 15,
  "30Min": 30,
};

function days(start: number, end: number): string[] {
  const out: string[] = [];
  const d = new Date(start);
  d.setUTCHours(12, 0, 0, 0);
  for (; d.getTime() < end + 86400000; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    if (coreClose(date) !== null) out.push(date);
  }
  return out;
}

function bars(symbol: string, timeframe: string, start: number, end: number) {
  const base = symbol === "SPY" ? 500 : 100;
  const out = [];
  for (const [i, date] of days(start, end).entries()) {
    if (timeframe === "1Day") {
      out.push({
        t: new Date(newYorkToUtc(date, 0)).toISOString(),
        o: base + i - 0.5,
        h: base + i + 1,
        l: base + i - 1,
        c: base + i,
        v: date === friday ? 300000 : 100000,
      });
      continue;
    }
    const m = minutes[timeframe]!;
    const row = (minute: number, k: number, v: number) => {
      const c = base + k / 100;
      return {
        t: new Date(newYorkToUtc(date, minute)).toISOString(),
        o: c - 0.01,
        h: c + 0.05,
        l: c - 0.05,
        c,
        v,
        vw: c,
      };
    };
    out.push(row(480, 0, 50));
    for (let minute = 570, k = 0; minute < coreClose(date)!; minute += m, k++)
      out.push(row(minute, k, (date === friday && k === 0 ? 2 : 1) * 1000 * m));
  }
  return out.filter((b) => {
    const t = Date.parse(b.t);
    return t >= start && t < end;
  });
}

function fetcher(seen: string[] = []) {
  return (async (input: URL) => {
    const symbol = decodeURIComponent(input.pathname.split("/")[3]!);
    const timeframe = input.searchParams.get("timeframe")!;
    seen.push(`${symbol} ${timeframe}`);
    assert.equal(input.searchParams.get("adjustment"), "split");
    return Response.json({
      bars: bars(
        symbol,
        timeframe,
        Date.parse(input.searchParams.get("start")!),
        Date.parse(input.searchParams.get("end")!),
      ),
      next_page_token: null,
    });
  }) as unknown as typeof fetch;
}

const afterClose = Date.parse("2026-10-16T21:00:00Z");
async function read(query: Record<string, string>, now = afterClose) {
  const seen: string[] = [];
  const out = await handleChartBars(query, credentials, fetcher(seen), now);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.ok("rows" in out.body);
  return { body: out.body, seen };
}

test("bars: 5m shows the sessions asked for, with the benchmark and previous closes", async () => {
  const { body, seen } = await read({
    ticker: "nvda",
    bar: "5m",
    sessions: "2",
  });
  assert.deepEqual(body.sessions, ["2026-10-15", friday]);
  assert.equal(body.against, "SPY");
  assert.equal(body.rows.length, 2 * 78);
  // The stock's own 5-minute bars also give today's volume: no extra read.
  assert.deepEqual(seen.sort(), ["NVDA 5Min", "SPY 5Min"]);
  const first = body.rows[78]!;
  assert.equal(first.date, friday);
  assert.equal(first.start, Date.parse("2026-10-16T13:30:00Z") / 1000);
  assert.equal(first.previousClose, 100.77); // Thursday's 15:55 bar
  assert.equal(first.againstPreviousClose, 500.77);
  assert.equal(first.against?.close, 500);
});

test("bars: average volume and percentile against the same bar time over 20 sessions", async () => {
  const { body } = await read({ ticker: "NVDA", bar: "5m", sessions: "2" });
  const [first, second] = [body.rows[78]!, body.rows[79]!];
  assert.equal(first.stock.volume, 10000);
  assert.equal(first.averageVolume, 5000);
  assert.equal(first.volumePercentile, 100);
  assert.equal(second.averageVolume, 5000);
  assert.equal(second.volumePercentile, 0); // equal volumes are not "less"
});

test("bars: the session VWAP adds up from the first regular bar and starts again each day", async () => {
  const { body } = await read({ ticker: "NVDA", bar: "5m", sessions: "2" });
  const day = body.rows.slice(78, 81);
  assert.equal(day[0]!.vwap, 100);
  // (100 × 10000 + 100.01 × 5000 + 100.02 × 5000) ÷ 20000
  assert.ok(Math.abs(day[2]!.vwap! - 100.0075) < 1e-9);
  assert.equal(body.rows[0]!.vwap, 100); // Thursday's first bar
});

test("bars: 1h joins two 30-minute bars from 09:30; the last hour is 15:30–16:00", async () => {
  const { body, seen } = await read({
    ticker: "NVDA",
    bar: "1h",
    sessions: "1",
  });
  assert.ok(seen.includes("NVDA 30Min") && seen.includes("NVDA 5Min"));
  assert.equal(body.rows.length, 7);
  const [first, last] = [body.rows[0]!, body.rows[6]!];
  assert.equal(first.start, Date.parse("2026-10-16T13:30:00Z") / 1000);
  assert.equal(first.stock.volume, 60000 + 30000);
  assert.equal(first.stock.open, 99.99);
  assert.equal(first.stock.close, 100.01);
  assert.equal(first.stock.high, 100.06);
  assert.equal(last.stock.volume, 30000);
});

test("bars: today's volume so far counts finished 5-minute steps, whatever the bar size", async () => {
  // 10:12 New York: steps up to 10:10 count.
  const { body } = await read(
    { ticker: "NVDA", bar: "15m", sessions: "1" },
    Date.parse("2026-10-16T14:12:00Z"),
  );
  assert.deepEqual(body.today, {
    date: friday,
    through: Date.parse("2026-10-16T14:10:00Z") / 1000,
    volume: 9 * 5000,
    averageVolume: 8 * 5000,
    percentile: 100,
    sessions: 20,
  });
  // The 15-minute bar still forming is shown as far as it goes.
  assert.equal(body.rows.at(-1)!.stock.volume, 15000);
});

test("bars: before the open, today drops out and yesterday is the last session", async () => {
  const { body } = await read(
    { ticker: "NVDA", bar: "5m", sessions: "2" },
    Date.parse("2026-10-16T12:00:00Z"),
  );
  assert.deepEqual(body.sessions, ["2026-10-14", "2026-10-15"]);
  assert.equal(body.today?.date, "2026-10-15");
  assert.equal(body.today?.volume, 78 * 5000);
});

test("bars: `end` shows the sessions up to that day, for older bars and past alerts", async () => {
  const { body } = await read({
    ticker: "NVDA",
    bar: "1m",
    sessions: "2",
    end: "2026-10-14",
  });
  assert.deepEqual(body.sessions, ["2026-10-13", "2026-10-14"]);
  assert.equal(body.rows.length, 2 * 390);
});

test("bars: 1D compares each day with the 20 days before and has no VWAP", async () => {
  const { body } = await read({ ticker: "NVDA", bar: "1D", sessions: "5" });
  assert.equal(body.rows.length, 5);
  const last = body.rows.at(-1)!;
  assert.equal(last.date, friday);
  assert.equal(last.vwap, null);
  assert.equal(last.averageVolume, 100000);
  assert.equal(last.volumePercentile, 100);
  assert.equal(last.previousClose, body.rows.at(-2)!.stock.close);
});

test("bars: a benchmark that is the stock itself is not read twice", async () => {
  const { body, seen } = await read({
    ticker: "SPY",
    bar: "5m",
    sessions: "1",
  });
  assert.equal(body.against, null);
  assert.ok(body.rows.every((r) => r.against === null));
  assert.deepEqual(seen, ["SPY 5Min"]);
});

test("bars: rejects unknown bar sizes, too many sessions and non-trading days", async () => {
  const call = (query: Record<string, string>, c = credentials) =>
    handleChartBars(query, c, fetcher(), afterClose);
  assert.equal((await call({ ticker: "NVDA", bar: "2m" })).status, 400);
  assert.equal(
    (await call({ ticker: "NVDA", bar: "1m", sessions: "6" })).status,
    400,
  );
  assert.equal(
    (await call({ ticker: "NVDA", bar: "5m", end: "2026-10-17" })).status,
    400,
  );
  assert.equal(
    (await call({ ticker: "NVDA", bar: "5m" }, { ...credentials, key: "" }))
      .status,
    503,
  );
});

test("bars: fewer than 15 sessions give no average or percentile", () => {
  assert.deepEqual(volumeRank(5, [1, 2, 3]), {
    average: null,
    percentile: null,
  });
  assert.deepEqual(
    volumeRank(
      10,
      Array.from({ length: 20 }, (_, i) => i),
    ),
    { average: 9.5, percentile: 50 },
  );
});
