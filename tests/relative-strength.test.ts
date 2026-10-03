import { test } from "node:test";
import assert from "node:assert/strict";
import {
  relation,
  scoreAgainst,
  type ScoreInput,
} from "../packages/analysis/src/relative-strength.js";
import {
  alert,
  dayBars,
  pairedDaily,
  previous,
  sessions,
} from "./analysis-fixtures.js";

// SYNTHETIC: AAPL 100 → 102 (+2%) while SPY 500 → 497 (−0.6%); in the
// 3-minute window SPY 499 → 497.
function input(noise = 0.02, overrides: Partial<ScoreInput> = {}): ScoreInput {
  const daily = pairedDaily(noise);
  return {
    alert: alert(),
    stockBars: dayBars("AAPL", 100, [
      [626, 101],
      [629, 102],
    ]),
    benchmark: "SPY",
    kind: "market",
    benchmarkBars: dayBars("SPY", 500, [
      [626, 499],
      [629, 497],
    ]),
    stockDaily: daily.stock,
    benchmarkDaily: daily.benchmark,
    sessions,
    previous,
    ...overrides,
  };
}

const close = (actual: number | undefined, expected: number) =>
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 1e-6,
    `${actual} ≈ ${expected}`,
  );

test("scores a stock rising while the index falls as against, above 50", () => {
  const s = scoreAgainst(input());
  close(s.beta, 1.5);
  assert.equal(s.betaAssumed, false);
  assert.equal(s.betaReturns, 60);
  close(s.day?.stock, 2);
  close(s.day?.benchmark, -0.6);
  close(s.day?.excess, 2 + 1.5 * 0.6);
  // The window uses the alert's own move and SPY's bars 3 minutes apart.
  close(s.window?.stock, 1);
  close(s.window?.benchmark, (497 / 499 - 1) * 100);
  assert.equal(s.relation, "against");
  // σ of ±2% daily excess over 20 returns = 2·√(20/19).
  close(s.sigma ?? undefined, 2 * Math.sqrt(20 / 19));
  assert.equal(s.score, Math.round(50 + (10 * 2.9) / (2 * Math.sqrt(20 / 19))));
});

test("clamps the score at 100 and 0", () => {
  assert.equal(scoreAgainst(input(0.002)).score, 100);
  const falling = input(0.002, {
    alert: alert({ close: 95, move: -1, direction: "down" }),
  });
  assert.equal(scoreAgainst(falling).score, 0);
});

test("classifies the day relation at the thresholds", () => {
  assert.equal(relation(2, 0.29, 1), "independent");
  assert.equal(relation(2, -0.29, 1), "independent");
  assert.equal(relation(2, -0.3, 1), "against");
  assert.equal(relation(-2, 0.3, 1), "against");
  // β·r_b ≥ 50% of the stock's move: the index explains it.
  assert.equal(relation(2, 1, 1), "with");
  assert.equal(relation(2, 0.99, 1), "outperform");
  assert.equal(relation(3, 0.5, 1.5), "outperform");
  assert.equal(relation(2, 1.5, 1.5), "with");
});

test("assumes β = 1 and gives no score without enough daily history", () => {
  const short = pairedDaily(0.02, sessions.slice(-10));
  const s = scoreAgainst(
    input(0.02, { stockDaily: short.stock, benchmarkDaily: short.benchmark }),
  );
  assert.equal(s.beta, 1);
  assert.equal(s.betaAssumed, true);
  assert.equal(s.sigma, null);
  assert.equal(s.score, null);
  // Relation still uses the assumed β.
  close(s.day?.excess, 2 + 0.6);
  assert.equal(s.relation, "against");
});

test("reports missing or stale benchmark bars as null horizons", () => {
  // No SPY bar inside the window: from and to are the same bar.
  const stale = scoreAgainst(
    input(0.02, { benchmarkBars: dayBars("SPY", 500, [[600, 498]]) }),
  );
  assert.equal(stale.window, null);
  close(stale.day?.benchmark, (498 / 500 - 1) * 100);
  assert.equal(
    stale.day?.benchmarkTo,
    dayBars("SPY", 500, [[600, 498]])[1]!.end,
  );
  // No previous close: no day horizon, relation or score.
  const none = scoreAgainst(
    input(0.02, { benchmarkBars: dayBars("SPY", 500, []).slice(1) }),
  );
  assert.equal(none.day, null);
  assert.equal(none.relation, null);
  assert.equal(none.score, null);
});

test("never reads benchmark bars after the alert bar", () => {
  const later = input(0.02, {
    benchmarkBars: dayBars("SPY", 500, [
      [626, 499],
      [629, 497],
      [630, 520],
    ]),
  });
  close(scoreAgainst(later).day?.benchmark, -0.6);
});
