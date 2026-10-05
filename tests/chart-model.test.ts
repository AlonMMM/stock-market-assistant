import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ChartBar,
  ChartSeries,
  DayChart,
} from "../packages/market-data/src/day-chart.js";
import type { MarksVsSpySeries } from "../packages/contracts/src/vs-spy.js";
import {
  bandKinds,
  alertWindowBars,
  barOpacity,
  chartScores,
  contributionBars,
  endMinute,
  gapPoints,
  outsideOpacity,
  dollars,
  episodeSummary,
  isStrongVolume,
  percentAndPrice,
  percentBase,
  priceAt,
  scoreAt,
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
const marks = (over: Partial<MarksVsSpySeries> = {}): MarksVsSpySeries => ({
  start: 1_000_000,
  contribution: [],
  mark: [],
  sum: [],
  sigma: [],
  score: [],
  beta: 2,
  betaAssumed: false,
  ...over,
});
const withMarks = (
  series: ChartSeries[],
  marksVsSpy?: MarksVsSpySeries,
): DayChart => ({ ...chart(series), marksVsSpy }) as DayChart;

test("score and contribution per bar come from the backend's minute series", () => {
  const nvda = series("NVDA", 100, [100, 101, 102]);
  const spy = series("SPY", 500, [500, 500, 501]);
  const s = chartScores(
    withMarks(
      [nvda, spy],
      marks({ contribution: [null, 0.4, -0.2], score: [null, 61, 72] }),
    ),
  )!;
  assert.deepEqual(s.scores, [null, 61, 72]);
  assert.deepEqual(s.contribution, [null, 0.4, -0.2]);
  assert.equal(scoreText(s.scores.at(-1)), "72 / 100");
  // The series starts at 09:30: a bar one minute earlier (pre-market) has
  // no value, the next bars shift by one minute.
  const late = chartScores(
    withMarks([nvda, spy], marks({ start: 1_000_060, score: [55, 56] })),
  )!;
  assert.deepEqual(late.scores, [null, 55, 56]);
  // Empty or short series → "—" per minute, nothing invented.
  const none = chartScores(withMarks([nvda, spy], marks()))!;
  assert.deepEqual(none.scores, [null, null, null]);
  assert.deepEqual(none.contribution, [null, null, null]);
  assert.equal(scoreText(none.scores.at(-1)), "—");
});

test("no score without marksVsSpy or for SPY itself", () => {
  const nvda = series("NVDA", 100, [101]);
  const spy = series("SPY", 500, [501]);
  assert.equal(chartScores(withMarks([nvda, spy])), null);
  assert.equal(chartScores(withMarks([spy], marks())), null);
});

// SYNTHETIC minute starts (Unix s) for the end-minute and weight tests.
const t0 = 1_790_000_000 - (1_790_000_000 % 60);
const at = (min: number) => ({ start: t0 + min * 60 });
const closeIso = (min: number) =>
  new Date((t0 + (min + 1) * 60) * 1000).toISOString();

test("end minute: before the alert's window in Around alert, else the latest bar", () => {
  const bars = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(at);
  // Alert bar = minute 7, 3-minute window 5–7 → E = minute 4.
  assert.equal(endMinute(bars, closeIso(7), 3, true), at(4).start);
  assert.equal(endMinute(bars, closeIso(7), 3, false), at(9).start);
  assert.equal(endMinute(bars, undefined, 3, true), at(9).start);
  // E is a clock minute even when its bar is missing.
  const gappy = [0, 1, 2, 3, 5, 6, 7].map(at);
  assert.equal(endMinute(gappy, closeIso(7), 3, true), at(4).start);
  assert.equal(endMinute([], undefined, 3, false), null);
});

test("header = the series' score at E, the alert's own value (scenario 7)", () => {
  const nvda = series("NVDA", 100, [100, 101, 102, 103, 104, 105]);
  const spy = series("SPY", 500, [500, 500, 500, 500, 500, 500]);
  const vs = chartScores(
    withMarks([nvda, spy], marks({ score: [50, 52, 73, 60, 45, 41] })),
  )!;
  const bars = nvda.bars;
  // Alert bar = minute 5, window 3 (minutes 3–5): E = minute 2 → 73, not
  // the alert bar's 41.
  const alertEnd = new Date((bars[5]!.start + 60) * 1000).toISOString();
  assert.equal(scoreAt(vs, endMinute(bars, alertEnd, 3, true)), 73);
  assert.equal(scoreAt(vs, endMinute(bars, alertEnd, 3, false)), 41);
  assert.equal(scoreAt(vs, null), null);
  assert.equal(scoreAt(null, bars[0]!.start), null);
  // Before 09:30 (pre-market alert) → "—".
  assert.equal(scoreAt(vs, bars[0]!.start - 60), null);
});

test("bar opacity: newest full, 60-minute-old faint, outside very faint", () => {
  assert.equal(barOpacity(1), 1);
  assert.ok(Math.abs(barOpacity(1 / 60) - 0.233) < 0.01);
  assert.ok(barOpacity(0.5) > barOpacity(0.2));
  assert.equal(barOpacity(0), outsideOpacity);
  assert.ok(outsideOpacity < barOpacity(1 / 60));
});

test("contribution bars: value, sign and fade relative to the end bar", () => {
  const bars = [0, 1, 10, 58, 59, 60, 61].map(at);
  const c = contributionBars(
    bars,
    [0.4, null, -0.2, 0.1, 0, Number.NaN, 0.3],
    at(60).start,
  );
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
  assert.equal(c[4]!.weight, 59 / 60);
  // 50 minutes before E: 10/60 (scenario 2).
  assert.equal(c[2]!.weight, 10 / 60);
  assert.equal(c[0]!.opacity, outsideOpacity);
  assert.equal(c[6]!.opacity, outsideOpacity);
  assert.ok(c[4]!.opacity > c[2]!.opacity);
  // Without an end minute nothing counts.
  assert.ok(contributionBars(bars, [], null).every((b) => b.weight === 0));
});

test("alert window bars: the alert's own minutes, excluded from its score", () => {
  const bars = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(at);
  assert.deepEqual(
    alertWindowBars(bars, Date.parse(closeIso(7)), 3),
    [5, 6, 7],
  );
  assert.deepEqual(alertWindowBars(bars, NaN, 3), []);
  assert.deepEqual(alertWindowBars(bars, Date.parse(closeIso(7)), 0), []);
  assert.equal(gapPoints(0.42), "+0.42 pts");
  assert.equal(gapPoints(-1.1), "−1.10 pts");
});
