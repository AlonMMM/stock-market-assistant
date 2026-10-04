import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ChartBar,
  ChartSeries,
  DayChart,
} from "../packages/market-data/src/day-chart.js";
import type { AreaVsSpySeries } from "../packages/contracts/src/vs-spy.js";
import {
  bandKinds,
  alertWindowBars,
  barOpacity,
  chartScores,
  contributionBars,
  endIndex,
  gapPoints,
  minuteWeight,
  outsideOpacity,
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
const area = (over: Partial<AreaVsSpySeries> = {}): AreaVsSpySeries => ({
  gap: [],
  area: [],
  score: [],
  sigma: [],
  windows: [],
  beta: 2,
  betaAssumed: false,
  ...over,
});
const withArea = (
  series: ChartSeries[],
  areaVsSpy?: AreaVsSpySeries,
): DayChart => ({ ...chart(series), areaVsSpy });

test("area score and gap per minute come from the backend's series", () => {
  const nvda = series("NVDA", 100, [100, 101, 102]);
  const spy = series("SPY", 500, [500, 500, 501]);
  const s = chartScores(
    withArea([nvda, spy], area({ gap: [0, 0.4, 1.2], score: [null, 61, 72] })),
  )!;
  assert.deepEqual(s.scores, [null, 61, 72]);
  assert.deepEqual(s.gap, [0, 0.4, 1.2]);
  assert.equal(s.latest, 72);
  assert.equal(scoreText(s.latest), "72 / 100");
  // Empty or short series → "—" per minute, nothing invented.
  const none = chartScores(withArea([nvda, spy], area()))!;
  assert.deepEqual(none.scores, [null, null, null]);
  assert.deepEqual(none.gap, [null, null, null]);
  assert.equal(scoreText(none.latest), "—");
  const short = chartScores(withArea([nvda, spy], area({ score: [50] })))!;
  assert.deepEqual(short.scores, [50, null, null]);
});

test("no score without areaVsSpy or for SPY itself", () => {
  const nvda = series("NVDA", 100, [101]);
  const spy = series("SPY", 500, [501]);
  assert.equal(chartScores(withArea([nvda, spy])), null);
  assert.equal(chartScores(withArea([spy], area())), null);
});

// SYNTHETIC minute starts (Unix s) for the end-minute and weight tests.
const t0 = 1_790_000_000 - (1_790_000_000 % 60);
const at = (min: number) => ({ start: t0 + min * 60 });
const closeMs = (min: number) => (t0 + (min + 1) * 60) * 1000;

test("end minute: before the alert's window in Around alert, else the latest bar", () => {
  const bars = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(at);
  // Alert bar = minute 7 (closes at closeMs(7)), 3-minute window 5–7 → E = 4.
  assert.equal(endIndex(bars, closeMs(7), 3, true), 4);
  assert.equal(endIndex(bars, closeMs(7), 3, false), 9);
  assert.equal(endIndex(bars, NaN, 3, true), 9);
  // Window 0: the alert bar itself.
  assert.equal(endIndex(bars, closeMs(7), 0, true), 7);
  // Minute 4 missing: the last bar before the window (minute 3).
  const gappy = [0, 1, 2, 3, 5, 6, 7].map(at);
  assert.equal(endIndex(gappy, closeMs(7), 3, true), 3);
  // No bar closes before the window → no end minute ("—").
  assert.equal(endIndex([5, 6, 7].map(at), closeMs(7), 3, true), -1);
  assert.equal(endIndex([], NaN, 3, false), -1);
});

test("weight: linear over the 60 minutes up to E by clock minute (scenarios 2, 5)", () => {
  const e = at(100).start;
  assert.equal(minuteWeight(at(100).start, e), 1);
  assert.equal(minuteWeight(at(99).start, e), 59 / 60);
  // 50 minutes before E: 10/60 (the spec rounds it to ≈ 0.18; scenario 2).
  assert.equal(minuteWeight(at(50).start, e).toFixed(2), "0.17");
  assert.equal(minuteWeight(at(41).start, e), 1 / 60);
  assert.equal(minuteWeight(at(40).start, e), 0); // 60 min old (scenario 5)
  assert.equal(minuteWeight(at(101).start, e), 0); // after E
});

test("bar opacity: newest full, 60-minute-old faint, outside very faint", () => {
  assert.equal(barOpacity(1), 1);
  assert.ok(Math.abs(barOpacity(1 / 60) - 0.233) < 0.01);
  assert.ok(barOpacity(0.5) > barOpacity(0.2));
  assert.equal(barOpacity(0), outsideOpacity);
  assert.ok(outsideOpacity < barOpacity(1 / 60));
});

test("contribution bars: value, sign and fade relative to the end bar", () => {
  const bars = [0, 1, 30, 58, 59, 60, 61].map(at);
  const c = contributionBars(bars, [0.4, null, -0.2, 0.1, 0, Number.NaN, 0.3], 5);
  assert.deepEqual(
    c.map((b) => b.value),
    [0.4, null, -0.2, 0.1, 0, null, 0.3],
  );
  assert.deepEqual(
    c.map((b) => b.up),
    [true, true, false, true, true, true, true],
  );
  // E = minute 60: minute 0 is 60 min old (outside), 61 is after E.
  assert.deepEqual(
    c.map((b) => b.inWindow),
    [false, true, true, true, true, true, false],
  );
  assert.equal(c[5]!.weight, 1);
  assert.equal(c[0]!.opacity, outsideOpacity);
  assert.equal(c[6]!.opacity, outsideOpacity);
  assert.ok(c[4]!.opacity > c[2]!.opacity);
  // Without an end bar nothing counts.
  assert.ok(contributionBars(bars, [], -1).every((b) => b.weight === 0));
});

test("alert window bars: the alert's own minutes, excluded from its score", () => {
  const bars = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(at);
  assert.deepEqual(alertWindowBars(bars, closeMs(7), 3), [5, 6, 7]);
  assert.deepEqual(alertWindowBars(bars, NaN, 3), []);
  assert.deepEqual(alertWindowBars(bars, closeMs(7), 0), []);
  assert.equal(gapPoints(0.42), "+0.42 pts");
  assert.equal(gapPoints(-1.1), "−1.10 pts");
});
