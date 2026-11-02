// SYNTHETIC bars: the trade chart's support and resistance, the day's range and the zoom.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChartBarsRow } from "../packages/market-data/src/chart-bars.js";
import type { TradeChartSession } from "../packages/market-data/src/trade-chart.js";
import {
  dayRange,
  tradeLevels,
  zoomRange,
} from "../apps/web/src/chart-levels.js";

const day = (date: string, high: number, low: number): ChartBarsRow => ({
  start: Date.parse(`${date}T04:00:00Z`) / 1000,
  date,
  stock: { open: low, high, low, close: high, volume: 1000 },
  against: null,
  previousClose: null,
  againstPreviousClose: null,
  vwap: null,
  averageVolume: null,
  volumePercentile: null,
});

const session = (bars: TradeChartSession["stock"]): TradeChartSession => ({
  date: "2026-10-09",
  minutes: 390,
  stock: bars,
  spy: [],
  strength: [],
  option: [],
});

test("levels: yesterday, the 5 sessions before the entry day, the first 15 minutes", () => {
  const daily = [
    day("2026-10-02", 110, 100),
    day("2026-10-05", 104, 95),
    day("2026-10-06", 103, 99),
    day("2026-10-07", 102, 98),
    day("2026-10-08", 106, 101),
    day("2026-10-09", 130, 90), // the entry day itself: not a level
  ];
  const entry = session([
    [0, 101, 103, 100.5, 102, 10],
    [14, 102, 104.5, 101.5, 104, 10],
    [15, 104, 120, 103, 119, 10], // after 09:45: not the opening range
  ]);
  const levels = tradeLevels(daily, "2026-10-09", entry);
  assert.deepEqual(
    levels.map((l) => [l.title, l.price, l.side]),
    [
      ["Yday high", 106, "high"],
      ["Yday low", 101, "low"],
      ["5-day high", 110, "high"],
      ["5-day low", 95, "low"],
      ["15-min high", 104.5, "high"],
      ["15-min low", 100.5, "low"],
    ],
  );
});

test("levels: no 5-day pair with fewer than 5 sessions, nothing without data", () => {
  const daily = [day("2026-10-07", 102, 98), day("2026-10-08", 106, 101)];
  assert.deepEqual(
    tradeLevels(daily, "2026-10-09", null).map((l) => l.title),
    ["Yday high", "Yday low"],
  );
  assert.deepEqual(tradeLevels(null, "2026-10-09", null), []);
});

test("the day's range: the high and low so far at each minute", () => {
  assert.deepEqual(
    dayRange([
      [0, 10, 11, 9, 10.5, 1],
      [1, 10.5, 10.8, 9.5, 10, 1],
      [2, 10, 12, 8, 11, 1],
    ]),
    [
      [0, 11, 9],
      [1, 11, 9],
      [2, 12, 8],
    ],
  );
});

test("zoom: halves or doubles the bars shown around the middle, at least 10", () => {
  assert.deepEqual(zoomRange({ from: 100, to: 200 }, 0.5), {
    from: 125,
    to: 175,
  });
  assert.deepEqual(zoomRange({ from: 100, to: 200 }, 2), { from: 50, to: 250 });
  assert.deepEqual(zoomRange({ from: 100, to: 108 }, 0.5), {
    from: 99,
    to: 109,
  });
});
