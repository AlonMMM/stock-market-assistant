import { test } from "node:test";
import assert from "node:assert/strict";
import { vsSpyLabel } from "../packages/contracts/src/vs-spy.js";
import {
  nowForAlert,
  strengthTrend,
  vsSpyCell,
  vsSpyDetail,
  type VsSpy,
} from "../apps/web/src/vs-spy-model.js";

// SYNTHETIC values, shaped like the spec's acceptance scenarios.
const vs = (over: Partial<VsSpy>): VsSpy => ({
  score: 65,
  area: 0.5,
  beta: 1.5,
  betaAssumed: false,
  label: "confirmed",
  spyLagged: false,
  ...over,
});

test("cell keeps arrow and words beside the colour for every label", () => {
  assert.deepEqual(vsSpyCell("up", vs({})), {
    tone: "confirmed",
    text: "▲ Long · confirmed",
    score: 65,
    title: "▲ Long · confirmed vs SPY · 65/100 at the alert",
  });
  assert.equal(
    vsSpyCell("down", vs({ score: 30 })).text,
    "▼ Short · confirmed",
  );
  const against = vsSpyCell("up", vs({ score: 38, label: "against" }));
  assert.equal(against.tone, "against");
  assert.equal(against.text, "▲ Up · against");
  assert.equal(against.score, 38);
  assert.equal(
    vsSpyCell("down", vs({ score: 70, label: "against" })).text,
    "▼ Down · against",
  );
  const market = vsSpyCell("down", vs({ score: 50, label: "market" }));
  assert.equal(market.tone, "market");
  assert.equal(market.text, "▼ · moving with market");
});

test("cell shows — without a score or vsSpy", () => {
  for (const v of [
    undefined,
    null,
    vs({ score: null, label: "none" }),
    vs({ score: null }),
  ]) {
    const c = vsSpyCell("up", v);
    assert.equal(c.tone, "none");
    assert.equal(c.text, "—");
    assert.equal(c.score, null);
  }
});

test("cell takes the label from the alert, not from local thresholds", () => {
  // 58 with "confirmed" would be "market" by the proposed thresholds; the
  // backend's label wins.
  assert.equal(vsSpyCell("up", vs({ score: 58 })).tone, "confirmed");
});

test("trend arrow turns at ±5 points", () => {
  assert.equal(strengthTrend(65, 72), "↑");
  assert.equal(strengthTrend(65, 70), "↑");
  assert.equal(strengthTrend(65, 69), "→");
  assert.equal(strengthTrend(65, 61), "→");
  assert.equal(strengthTrend(65, 60), "↓");
  assert.equal(strengthTrend(65, 65), "→");
});

test("detail line: at alert → now with trend and beta", () => {
  assert.equal(
    vsSpyDetail(vs({ score: 78, beta: 1.4 }), {
      score: 84,
      at: "2026-10-02T14:20:00Z",
    }),
    "vs SPY at alert 78 → now 84 ↑ · β 1.4",
  );
  assert.equal(
    vsSpyDetail(vs({ score: 65 }), { score: 72, at: "2026-10-02T14:20:00Z" }),
    "vs SPY at alert 65 → now 72 ↑ · β 1.5",
  );
  assert.equal(
    vsSpyDetail(vs({ score: 50, beta: 1, betaAssumed: true, label: "market" })),
    "vs SPY at alert 50 · β 1.0 (assumed)",
  );
  assert.equal(
    vsSpyDetail(vs({ score: 65 }), { score: null, at: "2026-10-02T14:20:00Z" }),
    "vs SPY at alert 65 · β 1.5",
  );
  assert.equal(
    vsSpyDetail(vs({ score: null, label: "none" }), {
      score: 55,
      at: "2026-10-02T14:20:00Z",
    }),
    "vs SPY at alert — (no score) · now 55 · β 1.5",
  );
  assert.equal(
    vsSpyDetail(undefined),
    "vs SPY at alert — (not available for this alert)",
  );
});

test("current score applies only to alerts from the same Israel day", () => {
  const now = { score: 84, at: "2026-10-02T19:59:00Z" }; // 22:59 Israel
  assert.equal(nowForAlert("2026-10-02T13:35:00Z", now), now);
  assert.equal(nowForAlert("2026-10-01T19:00:00Z", now), null);
  assert.equal(nowForAlert("2026-10-02T13:35:00Z", undefined), null);
  // 21:30 UTC is already the next Israel day.
  assert.equal(
    nowForAlert("2026-10-02T21:30:00Z", {
      score: 1,
      at: "2026-10-02T20:00:00Z",
    }),
    null,
  );
});

test("cell tone follows the shared vsSpyLabel at its boundaries", () => {
  for (const direction of ["up", "down"] as const)
    for (const score of [0, 40, 41, 59, 60, 100]) {
      const label = vsSpyLabel(direction, score);
      assert.equal(vsSpyCell(direction, vs({ score, label })).tone, label);
    }
});
