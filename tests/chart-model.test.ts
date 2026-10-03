import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChartBar } from "../packages/market-data/src/day-chart.js";
import {
  bandKinds,
  episodeSummary,
  isStrongVolume,
  stateText,
  typicalRatio,
} from "../apps/web/src/chart-model.js";

test("volume is full strength from 2× typical; unknown typical is faded (scenario 14)", () => {
  assert.equal(isStrongVolume(200, 100), true);
  assert.equal(isStrongVolume(190, 100), false);
  assert.equal(isStrongVolume(500, null), false);
  assert.equal(isStrongVolume(500, undefined), false);
  assert.equal(isStrongVolume(500, 0), false);
  assert.equal(typicalRatio(300, 100), 3);
  assert.equal(typicalRatio(300, null), null);
});

const bars = Array.from({ length: 30 }, (_, i): ChartBar => ({
  start: 1_000_000 + i * 60,
  session: "regular",
  open: 1,
  close: 1,
  volume: 1,
}));

test("episode summaries count episodes and minutes", () => {
  const episodes = [{ kind: "strong" as const, from: 5, to: 15 }];
  assert.equal(
    episodeSummary("strong", episodes, bars, "SPY", true),
    "Held while SPY fell: 1 time · 10 min",
  );
  assert.equal(
    episodeSummary("weak", episodes, bars, "SPY", true),
    "Fell while SPY held: none today",
  );
  assert.equal(
    episodeSummary("weak", episodes, bars, "SMH", false),
    "Fell while SMH held: none",
  );
  assert.equal(
    episodeSummary(
      "strong",
      [...episodes, { kind: "strong", from: 20, to: 26 }],
      bars,
      "SPY",
      true,
    ),
    "Held while SPY fell: 2 times · 16 min",
  );
});

test("bands cover each episode from its window start; strong wins overlaps", () => {
  const kinds = bandKinds(10, [
    { kind: "weak", from: 1, to: 4 },
    { kind: "strong", from: 3, to: 6 },
  ]);
  assert.deepEqual(kinds, [
    null,
    "weak",
    "weak",
    "strong",
    "strong",
    "strong",
    "strong",
    null,
    null,
    null,
  ]);
});

test("state chip text", () => {
  assert.equal(stateText("strong", "SPY"), "▲ Holding while SPY falls");
  assert.equal(stateText("weak", "SPY"), "▼ Falling while SPY holds");
  assert.equal(stateText(null, "SPY"), "With SPY");
});
