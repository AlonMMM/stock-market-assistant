import assert from "node:assert/strict";
import test from "node:test";
import {
  cumulativeTrades,
  nearestPoint,
  niceTicks,
  timeTicks,
  tradeTimeDomain,
  israelDayTicks,
  israelMidnight,
  moneyTick,
  percentTick,
  stepPath,
  tickStep,
} from "../apps/web/src/trade-history-model.js";
import type { ClosedTrade } from "../packages/trading/src/portfolio.js";
const trade = (pnl: number, closedAt: string): ClosedTrade => ({
  symbol: "TEST",
  underlying: "TEST",
  option: null,
  openedAt: "2026-10-12T10:00:00Z",
  closedAt,
  qty: 1,
  entry: 100,
  exit: 100 + pnl,
  pnl,
  pnlPct: pnl,
  expired: false,
});
test("realized curve sorts by actual close time and divides cumulative dollars by account base", () => {
  const trades = [
    trade(-25, "2026-10-13T12:00:00Z"),
    trade(100, "2026-10-12T12:00:00Z"),
    trade(50, "2026-10-13T12:00:00Z"),
  ];
  const points = cumulativeTrades(trades, 10000);
  assert.deepEqual(
    points.map((p) => p.pnl),
    [100, 75, 125],
  );
  assert.deepEqual(
    points.map((p) => p.pct),
    [1, 0.75, 1.25],
  );
  assert.equal(points[1]!.time, points[2]!.time);
  assert.equal(trades[0]!.pnl, -25);
});
test("empty, single, zero and missing account base", () => {
  assert.deepEqual(cumulativeTrades([], 10000), []);
  for (const base of [null, 0]) {
    assert.equal(
      cumulativeTrades([trade(0, "2026-10-13T12:00:00Z")], base)[0]!.pct,
      null,
    );
  }
  assert.equal(
    cumulativeTrades([trade(-20, "2026-10-13T12:00:00Z")], 10000)[0]!.pct,
    -0.2,
  );
});

test("axis ticks are round numbers that cover the range", () => {
  assert.deepEqual(niceTicks(-37, 212), [-100, 0, 100, 200, 300]);
  assert.deepEqual(niceTicks(0, 1), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(niceTicks(0, 0), [-1, -0.5, 0, 0.5, 1]);
});

test("time ticks pick a whole-day step for multi-day ranges", () => {
  const day = 86_400_000;
  const start = Date.parse("2026-09-13T00:00:00Z");
  const { ticks, daily } = timeTicks(start, start + 30 * day);
  assert.equal(daily, true);
  assert.ok(ticks.length >= 3 && ticks.length <= 6);
  assert.ok(ticks.every((t) => t >= start && t <= start + 30 * day));
  assert.equal(timeTicks(start, start + 6 * 3_600_000).daily, false);
});

test("trade time domain focuses on closes while retaining real timestamps", () => {
  const periodStart = Date.parse("2026-09-13T00:00:00Z");
  const periodEnd = Date.parse("2026-10-13T00:00:00Z");
  const first = Date.parse("2026-10-12T12:00:00Z");
  const last = Date.parse("2026-10-13T12:00:00Z");
  const [start, end] = tradeTimeDomain([first, last], periodStart, periodEnd);
  assert.equal(start, first - 2 * 3_600_000);
  assert.equal(end, last + 2 * 3_600_000);
  assert.ok(start > periodStart);
  assert.deepEqual(tradeTimeDomain([], periodStart, periodEnd), [
    periodStart,
    periodEnd,
  ]);
});

test("nearest point finds the closest trade time", () => {
  assert.equal(nearestPoint([10, 20, 40], 33), 2);
  assert.equal(nearestPoint([10, 20, 40], 14), 0);
  assert.equal(nearestPoint([], 5), -1);
});

test("step path: flat from the start, a jump at each close, flat to the end", () => {
  assert.equal(
    stepPath(
      [0, 50],
      [
        [10, 60],
        [30, 40],
      ],
      100,
    ),
    "M 0 50 H 10 V 60 H 30 V 40 H 100",
  );
  assert.equal(stepPath([5, 50], [], 80), "M 5 50 H 80");
});

test("day ticks sit on each Israel midnight, across the clock change", () => {
  // Israel left summer time on 2026-10-25 (UTC+3 → UTC+2).
  assert.equal(
    israelMidnight("2026-10-24"),
    Date.parse("2026-10-23T21:00:00Z"),
  );
  assert.equal(
    israelMidnight("2026-10-26"),
    Date.parse("2026-10-25T22:00:00Z"),
  );
  const ticks = israelDayTicks(
    Date.parse("2026-10-23T12:00:00Z"),
    Date.parse("2026-10-26T18:00:00Z"),
    5,
  );
  assert.deepEqual(ticks, [
    Date.parse("2026-10-23T21:00:00Z"), // Sat 24 Oct
    Date.parse("2026-10-24T21:00:00Z"), // Sun 25 Oct
    Date.parse("2026-10-25T22:00:00Z"), // Mon 26 Oct
  ]);
  // Many days: every second day at most.
  const month = israelDayTicks(
    Date.parse("2026-10-01T00:00:00Z"),
    Date.parse("2026-10-10T23:00:00Z"),
    5,
  );
  assert.ok(month.length <= 5);
});

test("axis labels are as precise as the step, never two alike", () => {
  const ticks = [98500, 99000, 99500, 100000, 100500];
  const labels = ticks.map((t) => moneyTick(t, tickStep(ticks)));
  assert.deepEqual(labels, [
    "$98,500",
    "$99,000",
    "$99,500",
    "$100,000",
    "$100,500",
  ]);
  assert.equal(new Set(labels).size, labels.length);
  assert.equal(moneyTick(100000, 5000), "$100K");
  assert.equal(moneyTick(-250, 50), "−$250");
  assert.equal(moneyTick(12.5, 0.5), "$12.50");
  assert.equal(percentTick(-1.25, 0.25), "−1.3%");
  assert.equal(percentTick(0.05, 0.05), "+0.05%");
  assert.equal(percentTick(0, 1), "0%");
});
