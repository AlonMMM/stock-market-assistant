import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreAgainst } from "../packages/analysis/src/relative-strength.js";
import { newYorkToUtc } from "../packages/market-data/src/calendar.js";
import type { ChartBar } from "../packages/market-data/src/day-chart.js";
import {
  excessPercent,
  excessSigma,
  rsScore,
  scoreSeries,
  spyStrength,
} from "../packages/market-data/src/rs-score.js";
import {
  alert,
  day,
  dayBars,
  pairedDaily,
  previous,
  sessions,
} from "./analysis-fixtures.js";

// SYNTHETIC market data throughout (see analysis-fixtures.ts).

test("scenario 4: stock +2.31%, SPY +0.31%, β 1.5, σ 1.2 → 65", () => {
  const excess = excessPercent(2.31, 0.31, 1.5);
  assert.ok(Math.abs(excess - 1.845) < 1e-9);
  assert.equal(rsScore(excess, 1.2), 65); // round(50 + 15.375)
  assert.equal(rsScore(0, 1.2), 50); // moving like SPY × β
});

test("scenario 5: clamps at 0/100; 14 of 20 daily returns give no score", () => {
  assert.equal(rsScore(8, 1), 100);
  assert.equal(rsScore(-8, 1), 0);
  assert.equal(rsScore(1, null), null);
  assert.equal(rsScore(null, 1), null);
  assert.equal(rsScore(1, 0), null);
  // 15 sessions → 14 paired returns: σ unavailable; 16 → 15 returns: enough.
  const fourteen = pairedDaily(0.02, sessions.slice(-15));
  assert.equal(
    excessSigma(sessions, fourteen.stock, fourteen.benchmark, 1.5),
    null,
  );
  const fifteen = pairedDaily(0.02, sessions.slice(-16));
  const sigma = excessSigma(sessions, fifteen.stock, fifteen.benchmark, 1.5);
  assert.ok(sigma !== null && sigma > 0);
  // Only the 20 returns before the day count: older history is ignored.
  const all = pairedDaily(0.02);
  assert.ok(
    Math.abs(
      excessSigma(sessions, all.stock, all.benchmark, 1.5)! -
        2 * Math.sqrt(20 / 19),
    ) < 1e-9,
  );
});

const chartBar = (minute: number, close: number): ChartBar => ({
  start: newYorkToUtc(day, minute) / 1000,
  session: minute < 570 ? "pre" : "regular",
  open: close,
  close,
  volume: 1000,
});

test("scenario 7: the alert analysis and the chart score agree at the alert minute", () => {
  const daily = pairedDaily(0.02);
  const analysis = scoreAgainst({
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
  });
  const strength = spyStrength(
    sessions.slice(-61),
    daily.stock,
    daily.benchmark,
  );
  assert.equal(strength.beta, analysis.beta);
  assert.equal(strength.betaAssumed, analysis.betaAssumed);
  assert.equal(strength.sigma, analysis.sigma);
  const scores = scoreSeries(
    { previousClose: 100, bars: [chartBar(626, 101), chartBar(629, 102)] },
    { previousClose: 500, bars: [chartBar(626, 499), chartBar(629, 497)] },
    strength,
  );
  assert.ok(analysis.score !== null && analysis.score > 50);
  assert.equal(scores[1], analysis.score);
});

test("scoreSeries uses SPY's latest bar at or before each minute", () => {
  const strength = { beta: 1, sigma: 1 };
  const scores = scoreSeries(
    {
      previousClose: 100,
      bars: [chartBar(480, 100), chartBar(600, 101), chartBar(601, 101)],
    },
    // No SPY bar at 08:00 (pre-market); its 10:00 bar also serves 10:01.
    { previousClose: 500, bars: [chartBar(600, 500)] },
    strength,
  );
  assert.deepEqual(scores, [null, 60, 60]);
  // Missing base or σ: no score.
  assert.deepEqual(
    scoreSeries(
      { previousClose: null, bars: [chartBar(600, 101)] },
      { previousClose: 500, bars: [chartBar(600, 500)] },
      strength,
    ),
    [null],
  );
  assert.deepEqual(
    scoreSeries(
      { previousClose: 100, bars: [chartBar(600, 101)] },
      { previousClose: 500, bars: [chartBar(600, 500)] },
      { beta: 1, sigma: null },
    ),
    [null],
  );
});
