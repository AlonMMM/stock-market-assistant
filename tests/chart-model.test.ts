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
  gapPoints,
  headerIndex,
  dollars,
  episodeSummary,
  isStrongVolume,
  percentAndPrice,
  percentBase,
  priceAt,
  scoreText,
  weightRamp,
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
const strength = { beta: 2, betaAssumed: false, betaReturns: 60, sigma: 1 };

test("area score and gap per minute come from the backend's series", () => {
  const nvda = series("NVDA", 100, [100, 101, 102]);
  const spy = series("SPY", 500, [500, 500, 501]);
  const s = chartScores(
    chart([nvda, spy], {
      ...strength,
      gap: [0, 0.4, 1.2],
      scores: [null, 61, 72],
    } as DayChart["vsSpy"]),
  )!;
  assert.deepEqual(s.scores, [null, 61, 72]);
  assert.deepEqual(s.gap, [0, 0.4, 1.2]);
  assert.equal(s.latest, 72);
  assert.equal(scoreText(s.latest), "72 / 100");
  // Missing or short series → "—" per minute, nothing invented.
  const none = chartScores(chart([nvda, spy], strength))!;
  assert.deepEqual(none.scores, [null, null, null]);
  assert.deepEqual(none.gap, [null, null, null]);
  assert.equal(scoreText(none.latest), "—");
  const short = chartScores(
    chart([nvda, spy], { ...strength, scores: [50] } as DayChart["vsSpy"]),
  )!;
  assert.deepEqual(short.scores, [50, null, null]);
});

test("no score without vsSpy or for SPY itself", () => {
  const nvda = series("NVDA", 100, [101]);
  const spy = series("SPY", 500, [501]);
  assert.equal(chartScores(chart([nvda, spy])), null);
  assert.equal(chartScores(chart([spy], strength)), null);
});

test("header ends at the alert minute only in Around alert", () => {
  assert.equal(headerIndex(10, 4, true), 4);
  assert.equal(headerIndex(10, 4, false), 9);
  assert.equal(headerIndex(10, -1, true), 9);
  assert.equal(headerIndex(0, -1, false), -1);
});

test("weight ramp: linear by minute within the session containing T", () => {
  const bar = (min: number, session: string) => ({
    start: 1_000_000 + min * 60,
    session,
  });
  const bars = [
    bar(0, "pre"),
    bar(1, "pre"),
    bar(10, "regular"),
    bar(11, "regular"),
    bar(13, "regular"), // minute 12 missing: weight still by clock minute
    bar(14, "regular"),
  ];
  assert.deepEqual(weightRamp(bars, 5), [null, null, 0.2, 0.4, 0.8, 1]);
  assert.deepEqual(weightRamp(bars, 3), [null, null, 0.5, 1, null, null]);
  assert.deepEqual(weightRamp(bars, 1), [0.5, 1, null, null, null, null]);
  assert.deepEqual(
    weightRamp(bars, 9),
    bars.map(() => null),
  );
  assert.equal(gapPoints(0.42), "+0.42 pts");
  assert.equal(gapPoints(-1.1), "−1.10 pts");
});
