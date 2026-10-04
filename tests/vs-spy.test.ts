import { test } from "node:test";
import assert from "node:assert/strict";
import {
  vsSpyLabel,
  vsSpyText,
  type AlertVsSpy,
} from "../packages/contracts/src/vs-spy.js";

test("direction label follows the spec table, boundaries included", () => {
  const cases: [("up" | "down" | null)[], number | null, string][] = [
    [["up"], 60, "confirmed"],
    [["up"], 100, "confirmed"],
    [["up"], 59, "market"],
    [["up"], 41, "market"],
    [["up"], 40, "against"],
    [["up"], 0, "against"],
    [["down"], 40, "confirmed"],
    [["down"], 0, "confirmed"],
    [["down"], 41, "market"],
    [["down"], 59, "market"],
    [["down"], 60, "against"],
    [["down"], 100, "against"],
    [["up", "down", null], null, "none"],
    [[null], 50, "market"],
    // No direction: nothing to confirm or contradict.
    [[null], 78, "none"],
    [[null], 22, "none"],
  ];
  for (const [directions, score, label] of cases)
    for (const direction of directions)
      assert.equal(
        vsSpyLabel(direction, score),
        label,
        `${direction} ${score}`,
      );
  assert.equal(vsSpyLabel("up", Number.NaN), "none");
  assert.equal(vsSpyLabel("up", undefined), "none");
});

test("one-line text for Telegram and the site", () => {
  const v = (score: number | null, direction: "up" | "down"): AlertVsSpy => ({
    score,
    beta: 1.4,
    betaAssumed: false,
    label: vsSpyLabel(direction, score),
    spyLagged: false,
  });
  assert.equal(
    vsSpyText("up", v(78, "up")),
    "▲ Long · confirmed vs SPY · 78/100",
  );
  assert.equal(
    vsSpyText("down", v(22, "down")),
    "▼ Short · confirmed vs SPY · 22/100",
  );
  assert.equal(vsSpyText("up", v(38, "up")), "▲ Up · against SPY · 38/100");
  assert.equal(
    vsSpyText("down", v(65, "down")),
    "▼ Down · against SPY · 65/100",
  );
  assert.equal(
    vsSpyText("down", v(50, "down")),
    "▼ · moving with market · 50/100",
  );
  assert.equal(vsSpyText("up", v(null, "up")), "vs SPY —");
  assert.equal(vsSpyText("up", undefined), "vs SPY —");
});
