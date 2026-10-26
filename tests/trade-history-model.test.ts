import assert from "node:assert/strict";
import test from "node:test";
import {
  cumulativeTrades,
  dayLabels,
  nearestPoint,
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

test("nearest point finds the closest trade time", () => {
  assert.equal(nearestPoint([10, 20, 40], 33), 2);
  assert.equal(nearestPoint([10, 20, 40], 14), 0);
  assert.equal(nearestPoint([], 5), -1);
});

test("day labels: one per Israel date, under its trades, never overlapping", () => {
  const t = (iso: string) => Date.parse(iso);
  // Three trades on Friday 23 Oct and one on Monday 26 Oct (Israel time).
  const times = [
    t("2026-10-23T14:20:00Z"),
    t("2026-10-23T18:40:00Z"),
    t("2026-10-23T19:30:00Z"),
    t("2026-10-26T16:47:00Z"),
  ];
  assert.deepEqual(dayLabels([90, 175, 260, 340], times, 350), [
    { x: 175, text: "Fri 23 Oct", anchor: "middle" },
    { x: 340, text: "Mon 26 Oct", anchor: "end" },
  ]);
  // Too close to fit both: the last day wins.
  assert.deepEqual(
    dayLabels([300, 330], [times[0]!, times[3]!], 350).map((l) => l.text),
    ["Mon 26 Oct"],
  );
  // A day at the left edge starts there.
  assert.equal(dayLabels([5], [times[0]!], 350)[0]!.anchor, "start");
});
