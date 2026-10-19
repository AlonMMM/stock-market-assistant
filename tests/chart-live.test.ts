import assert from "node:assert/strict";
import test from "node:test";
import {
  advance,
  barSlot,
  chartTrading,
  liveMinute,
  minuteSlot,
  sessionOf,
  withLiveCandles,
  withLiveRows,
  type Running,
} from "../apps/web/src/chart-live.js";
import type { Candles } from "../packages/market-data/src/candles.js";
import type { ChartBarsRow } from "../packages/market-data/src/chart-bars.js";

// Synthetic prices. 2026-10-19 is a Monday; New York is UTC−4.
const ny = (hhmm: string, seconds = 0) =>
  Date.parse(`2026-10-19T${hhmm}:00-04:00`) + seconds * 1000;
const s = (ms: number) => ms / 1000;

test("sessions: pre-market, regular hours, after-hours, closed", () => {
  assert.equal(sessionOf(ny("03:59"))?.part, undefined);
  assert.equal(sessionOf(ny("04:00"))?.part, "pre");
  assert.equal(sessionOf(ny("09:30"))?.part, "regular");
  assert.equal(sessionOf(ny("16:00"))?.part, "post");
  assert.equal(sessionOf(ny("20:00")), null);
  assert.equal(sessionOf(Date.parse("2026-10-18T12:00:00-04:00")), null); // Sunday
  assert.equal(chartTrading("2026-10-19", ny("10:00")), true);
  assert.equal(chartTrading("2026-10-16", ny("10:00")), false);
});

const candles = (): Candles => ({
  ticker: "NVDA",
  date: "2026-10-19",
  previousClose: 100,
  candles: [
    {
      start: s(ny("10:00")),
      session: "regular",
      open: 101,
      high: 102,
      low: 100,
      close: 101.5,
      volume: 500,
    },
  ],
  last: { price: 101.5, at: ny("10:00", 30) },
  at: ny("10:00", 31),
});

// A running bar from trades, the way the chart builds it each second.
const run = (
  slot: (at: number) => number | null,
  ...trades: [number, number][]
) =>
  trades.reduce<Running | null>((r, [price, at]) => {
    const start = slot(at);
    return start === null ? r : advance(r, { price, at }, start);
  }, null);

test("running bar: opens at the first trade of its slot, then widens", () => {
  const r = run(
    minuteSlot,
    [103, ny("10:01", 2)],
    [105, ny("10:01", 20)],
    [101, ny("10:01", 40)],
  );
  assert.deepEqual(r, {
    start: s(ny("10:01")),
    open: 103,
    high: 105,
    low: 101,
    close: 101,
    at: ny("10:01", 40),
  });
  // The next minute starts a new bar; a late, older trade changes nothing.
  const next = advance(r, { price: 99, at: ny("10:02", 1) }, s(ny("10:02")));
  assert.equal(next.open, 99);
  assert.equal(
    advance(next, { price: 1, at: ny("10:01", 59) }, s(ny("10:01"))),
    next,
  );
});

test("candles: the running bar merges into its minute's candle", () => {
  const r = run(minuteSlot, [103, ny("10:00", 40)], [99, ny("10:00", 50)]);
  const c = withLiveCandles(candles(), r);
  assert.equal(c.candles.length, 1);
  assert.deepEqual(c.candles[0], {
    ...candles().candles[0]!,
    high: 103,
    low: 99,
    close: 99,
  });
  assert.deepEqual(c.last, { price: 99, at: ny("10:00", 50) });
});

test("candles: a new minute keeps its first trade as the open", () => {
  const r = run(minuteSlot, [99, ny("10:01", 5)], [104, ny("10:01", 30)]);
  const c = withLiveCandles(candles(), r);
  assert.equal(c.candles.length, 2);
  assert.deepEqual(c.candles[1], {
    start: s(ny("10:01")),
    session: "regular",
    open: 99,
    high: 104,
    low: 99,
    close: 104,
    volume: 0,
  });
  const before = candles();
  assert.equal(withLiveCandles(before, null), before);
  // Older than the server's last trade, or another session: unchanged.
  assert.equal(
    withLiveCandles(before, run(minuteSlot, [1, ny("10:00", 10)])),
    before,
  );
  assert.equal(
    withLiveCandles(
      before,
      run(minuteSlot, [1, Date.parse("2026-10-16T17:00:00-04:00")]),
    ),
    before,
  );
});

const row = (
  start: number,
  close: number,
  against: number | null,
): ChartBarsRow => ({
  start: s(start),
  date: "2026-10-19",
  stock: { open: close, high: close, low: close, close, volume: 10 },
  against:
    against === null
      ? null
      : {
          open: against,
          high: against,
          low: against,
          close: against,
          volume: 10,
        },
  previousClose: 100,
  againstPreviousClose: 500,
  vwap: 100.5,
  averageVolume: 12,
  volumePercentile: 40,
});

test("full screen 5m: running bars widen the forming bar, or open the next", () => {
  const slot = (at: number) => barSlot("5m", at);
  const rows = [row(ny("10:00"), 101, 501), row(ny("10:05"), 102, 502)];
  const same = withLiveRows(
    rows,
    "5m",
    run(slot, [104, ny("10:08")]),
    run(slot, [503, ny("10:08")]),
  );
  assert.equal(same.length, 2);
  assert.deepEqual(same[1]!.stock, {
    open: 102,
    high: 104,
    low: 102,
    close: 104,
    volume: 10,
  });
  assert.equal(same[1]!.against?.close, 503);
  const next = withLiveRows(
    rows,
    "5m",
    run(slot, [99, ny("10:11")], [100, ny("10:12")]),
    null,
  );
  assert.equal(next.length, 3);
  assert.equal(next[2]!.start, s(ny("10:10")));
  assert.deepEqual(next[2]!.stock, {
    open: 99,
    high: 100,
    low: 99,
    close: 100,
    volume: 0,
  });
  assert.equal(next[2]!.against, null);
  assert.equal(next[2]!.previousClose, 100);
});

test("full screen: regular hours only; 1D moves today's bar; 1h from 09:30", () => {
  assert.equal(barSlot("1m", ny("16:30")), null);
  assert.equal(barSlot("1m", ny("08:00")), null);
  const daily = [
    {
      ...row(ny("09:30"), 101, 501),
      start: s(Date.parse("2026-10-19T00:00:00-04:00")),
    },
  ];
  const moved = withLiveRows(
    daily,
    "1D",
    run((at) => barSlot("1D", at), [95, ny("11:00")]),
    null,
  );
  assert.equal(moved.length, 1);
  assert.deepEqual(moved[0]!.stock, {
    open: 101,
    high: 101,
    low: 95,
    close: 95,
    volume: 10,
  });
  assert.equal(barSlot("1h", ny("10:45")), s(ny("10:30")));
  assert.equal(barSlot("15m", ny("09:44")), s(ny("09:30")));
});

test("day chart: the newest minute of a trade, never an older one", () => {
  const series = {
    ticker: "NVDA",
    previousClose: 100,
    bars: [
      {
        start: s(ny("10:00")),
        session: "regular" as const,
        open: 1,
        close: 1,
        volume: 1,
      },
    ],
  };
  assert.deepEqual(
    liveMinute(series, "2026-10-19", { price: 7, at: ny("10:02", 9) }),
    {
      start: s(ny("10:02")),
      close: 7,
    },
  );
  assert.equal(
    liveMinute(series, "2026-10-19", { price: 7, at: ny("09:59") }),
    null,
  );
  assert.equal(
    liveMinute(series, "2026-10-16", { price: 7, at: ny("10:02") }),
    null,
  );
});
