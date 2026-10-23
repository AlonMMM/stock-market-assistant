import assert from "node:assert/strict";
import test from "node:test";
import {
  cumulativeTrades,
  dailyCloses,
  monotonePath,
  nearestPoint,
  niceTicks,
  timeTicks,
  tradeTimeDomain,
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

test("monotone curve passes through every point without overshooting", () => {
  const path = monotonePath([
    [0, 0],
    [10, 10],
    [20, 10],
    [30, 0],
  ]);
  assert.match(path, /^M 0 0 C /);
  const numbers = path.match(/-?[\d.]+/g)!.map(Number);
  const ys = numbers.filter((_, i) => i % 2 === 1);
  assert.ok(ys.every((v) => v >= 0 && v <= 10));
  assert.ok(path.endsWith(" 30 0"));
  assert.equal(monotonePath([[5, 5]]), "M 5 5");
  assert.match(
    monotonePath([
      [0, 0],
      [0, 5],
    ]),
    / L 0 5$/,
  );
});

test("daily closes: one point per Israel day, the day's P&L and trade count", () => {
  const points = cumulativeTrades(
    [
      trade(-100, "2026-10-12T14:00:00Z"),
      trade(50, "2026-10-12T19:00:00Z"),
      // 22:30 UTC is already the 13th in Israel.
      trade(300, "2026-10-12T22:30:00Z"),
      trade(-20, "2026-10-14T15:00:00Z"),
    ],
    100000,
  );
  assert.deepEqual(
    dailyCloses(points).map((d) => [d.day, d.pnl, d.dayPnl, d.trades]),
    [
      ["2026-10-12", -50, -50, 2],
      ["2026-10-13", 250, 300, 1],
      ["2026-10-14", 230, -20, 1],
    ],
  );
});
