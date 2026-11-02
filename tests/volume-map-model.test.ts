// SYNTHETIC scan rows: how close a stock is to a Volume bot alert.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { StrangleScanRow } from "../packages/trading/src/strangle/view.js";
import {
  addReading,
  byReadiness,
  missingText,
  readiness,
  trendWay,
} from "../apps/web/src/volume-map-model.js";

const row = (o: Partial<StrangleScanRow>): StrangleScanRow => ({
  symbol: "QQQ",
  minute: 300,
  volRatio: 1,
  moveRatio: 1,
  shares: 50_000,
  movePct: 1,
  side: "down",
  ...o,
});

test("readiness: the weakest check decides, even one the map does not draw", () => {
  // QQQ of 2 Nov 21:06: near the map's corner, a 0.06% price move of 0.5%.
  const q = readiness(row({ volRatio: 3.9, moveRatio: 2.4, movePct: 0.06 }));
  assert.equal(Number(q.share.toFixed(2)), 0.12);
  assert.equal(q.met, 1);
  assert.deepEqual(
    q.missing.map((c) => c.key),
    ["price", "move", "volume"],
  );
  assert.equal(
    missingText(q),
    "needs price move 0.06% of 0.50% · move 2.4× of 3.0× · volume 3.9× of 4.0×",
  );
});

test("readings round down: 3.98× is not shown as the 4× it needs", () => {
  const x = readiness(row({ volRatio: 3.98, moveRatio: 3.5 }));
  assert.equal(missingText(x), "needs volume 3.9× of 4.0×");
});

test("readiness: all four met is 100%", () => {
  const x = readiness(row({ volRatio: 5, moveRatio: 3.2 }));
  assert.equal(x.share, 1);
  assert.equal(x.met, 4);
  assert.match(missingText(x), /^All four met/);
});

test("byReadiness: the closest first", () => {
  const order = byReadiness([
    row({ symbol: "A", volRatio: 2, moveRatio: 2 }), // 2/4 = 50%
    row({ symbol: "B", volRatio: 3.6, moveRatio: 2.7 }), // 90%
    row({ symbol: "C", volRatio: 3.9, moveRatio: 2.4, movePct: 0.06 }), // 12%
  ]).map((r) => r.symbol);
  assert.deepEqual(order, ["B", "A", "C"]);
});

test("trend: readings kept for 20 minutes; rising or falling by 5 points", () => {
  let t = new Map<number, number>();
  t = addReading(t, 100, 0.4);
  t = addReading(t, 110, 0.5);
  assert.equal(trendWay(t), "up");
  t = addReading(t, 125, 0.3); // minute 100 drops out of the window
  assert.deepEqual([...t.keys()], [110, 125]);
  assert.equal(trendWay(t), "down");
  assert.equal(trendWay(addReading(new Map(), 1, 0.5)), "flat");
});
