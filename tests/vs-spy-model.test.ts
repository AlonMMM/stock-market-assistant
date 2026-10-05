import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nowForAlert,
  scoreCell,
  scoreTone,
  strengthTrend,
  vsSpyCell,
  vsSpyDetail,
  type VsSpy,
} from "../apps/web/src/vs-spy-model.js";

// SYNTHETIC values, shaped like the spec's acceptance scenarios.
const vs = (over: Partial<VsSpy>): VsSpy => ({
  score: 72,
  sum: 0.6,
  beta: 2,
  betaAssumed: false,
  spyLagged: false,
  ...over,
});

const labels = /confirmed|against|with market|moving with|\bLong\b|\bShort\b/i;

test("cell shows only the score, coloured by 60 / 40 (area-vs-spy)", () => {
  const c = vsSpyCell(vs({}));
  assert.equal(c.tone, "stronger");
  assert.equal(c.text, "72");
  assert.equal(c.score, 72);
  assert.match(c.title, /^vs SPY 72 \/ 100 at the alert: stronger vs SPY/);
  assert.equal(vsSpyCell(vs({ score: 38 })).tone, "weaker");
  assert.match(vsSpyCell(vs({ score: 38 })).title, /weaker vs SPY/);
  assert.equal(vsSpyCell(vs({ score: 50 })).tone, "normal");
  assert.match(vsSpyCell(vs({ score: 50 })).title, /normal vs SPY/);
});

test("tone boundaries: ≥ 60 green, ≤ 40 red, grey between", () => {
  const tones = [0, 40, 41, 59, 60, 100].map(scoreTone);
  assert.deepEqual(tones, [
    "weaker",
    "weaker",
    "normal",
    "normal",
    "stronger",
    "stronger",
  ]);
  assert.equal(scoreTone(null), "none");
  assert.equal(scoreTone(undefined), "none");
  assert.equal(scoreTone(NaN), "none");
});

test("cell shows — without a score or vsSpy", () => {
  for (const v of [undefined, null, vs({ score: null })]) {
    const c = vsSpyCell(v);
    assert.equal(c.tone, "none");
    assert.equal(c.text, "—");
    assert.equal(c.score, null);
  }
  assert.equal(scoreCell(null).text, "—");
});

test("old alerts with a stored label render the score only (scenario 8)", () => {
  for (const label of ["confirmed", "against", "market", "none"]) {
    const c = vsSpyCell(vs({ score: 58, label }));
    assert.equal(c.text, "58");
    assert.equal(c.tone, "normal"); // from the score, not the label
    assert.doesNotMatch(`${c.text} ${c.title}`, labels);
  }
  assert.doesNotMatch(vsSpyDetail(vs({ label: "confirmed" })), labels);
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
    vsSpyDetail(vs({}), { score: 64, at: "2026-10-02T14:20:00Z" }),
    "vs SPY at alert 72 → now 64 ↓ · β 2.0",
  );
  assert.equal(
    vsSpyDetail(vs({ score: 78, beta: 1.4 }), {
      score: 84,
      at: "2026-10-02T14:20:00Z",
    }),
    "vs SPY at alert 78 → now 84 ↑ · β 1.4",
  );
  assert.equal(
    vsSpyDetail(vs({ score: 65, beta: 1.5 }), {
      score: 72,
      at: "2026-10-02T14:20:00Z",
    }),
    "vs SPY at alert 65 → now 72 ↑ · β 1.5",
  );
  assert.equal(
    vsSpyDetail(vs({ score: 50, beta: 1, betaAssumed: true })),
    "vs SPY at alert 50 · β 1.0 (assumed)",
  );
  assert.equal(
    vsSpyDetail(vs({ score: 65, beta: 1.5 }), {
      score: null,
      at: "2026-10-02T14:20:00Z",
    }),
    "vs SPY at alert 65 · β 1.5",
  );
  assert.equal(
    vsSpyDetail(vs({ score: null, beta: 1.5 }), {
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
