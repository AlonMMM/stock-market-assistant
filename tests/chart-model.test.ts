import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ChartBar,
  ChartSeries,
  DayChart,
} from "../packages/market-data/src/day-chart.js";
import {
  bandKinds,
  chartScores,
  dollars,
  episodeSummary,
  isStrongVolume,
  percentAndPrice,
  percentBase,
  priceAt,
  scoreText,
  signedPercent,
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

test("percent and price labels (chart-vs-spy scenario 2)", () => {
  assert.equal(percentAndPrice(1.92, 131.05), "+1.92% · $131.05");
  assert.equal(percentAndPrice(-0.4, 572.4), "−0.40% · $572.40");
  assert.equal(signedPercent(0), "+0.00%");
  assert.equal(dollars(573.1), "$573.10");
  assert.equal(percentBase({ previousClose: 100, bars: [{ close: 90 }] }), 100);
  assert.equal(percentBase({ previousClose: null, bars: [{ close: 90 }] }), 90);
  assert.ok(Math.abs(priceAt(2.31, 128.66) - 131.632) < 0.001);
});

// SYNTHETIC minute series for the score vs SPY.
const series = (ticker: string, previousClose: number, closes: number[]) =>
  ({
    ticker,
    previousClose,
    bars: closes.map((close, i) => ({
      start: 1_000_000 + i * 60,
      session: "regular",
      open: close,
      close,
      volume: 1,
    })),
  }) satisfies ChartSeries;
const chart = (series: ChartSeries[], vsSpy?: DayChart["vsSpy"]): DayChart => ({
  source: "alpaca",
  feed: "sip",
  date: "2026-10-02",
  series,
  beta: { value: null, returns: 0, lookback: 60 },
  vsSpy,
});
const strength = { beta: 1.5, betaAssumed: false, betaReturns: 60, sigma: 1.2 };

test("score vs SPY per minute (chart-vs-spy scenarios 4, 5)", () => {
  // Minute 2: NVDA +2.31%, SPY +0.31%, β 1.5, σ 1.2 → 65.
  const nvda = series("NVDA", 100, [100, 101, 102.31]);
  const spy = series("SPY", 500, [500, 500, 501.55]);
  const s = chartScores(chart([nvda, spy], strength))!;
  assert.deepEqual(s.scores, [50, 58, 65]);
  assert.equal(s.latest, 65);
  assert.equal(s.betaAssumed, false);
  // Sector chart: SPY comes from vsSpy.spy, the sector series is ignored.
  const smh = series("SMH", 200, [200, 210, 220]);
  assert.deepEqual(
    chartScores(chart([nvda, smh], { ...strength, spy }))!.scores,
    [50, 58, 65],
  );
  // Clamped at 100; no σ → every minute "—".
  const jump = series("NVDA", 100, [108]);
  const flat = series("SPY", 500, [500]);
  const sigmaOne = { ...strength, beta: 1, sigma: 1 };
  assert.deepEqual(chartScores(chart([jump, flat], sigmaOne))!.scores, [100]);
  const none = chartScores(chart([nvda, spy], { ...strength, sigma: null }))!;
  assert.deepEqual(none.scores, [null, null, null]);
  assert.equal(scoreText(none.latest), "—");
  assert.equal(scoreText(72), "72 / 100");
});

test("no score without vsSpy, SPY's minutes, or for SPY itself", () => {
  const nvda = series("NVDA", 100, [101]);
  const spy = series("SPY", 500, [501]);
  const smh = series("SMH", 200, [201]);
  assert.equal(chartScores(chart([nvda, spy])), null);
  assert.equal(chartScores(chart([nvda, smh], strength)), null);
  assert.equal(chartScores(chart([spy], strength)), null);
});
