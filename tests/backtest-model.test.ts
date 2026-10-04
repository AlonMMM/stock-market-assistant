import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  BacktestAlert,
  BacktestResult,
} from "../packages/market-data/src/backtest.js";
import {
  validationDefaults,
  type Outcome,
  type ValidationSummary,
} from "../packages/market-data/src/outcome.js";
import {
  changeBadge,
  datePreset,
  dayScoreLabel,
  filterLook,
  lookCounts,
  peakLabel,
  diagnosticBars,
  lastCompleteSession,
  lastSessions,
  liveSettings,
  mergeResults,
  minTrusted,
  previewTickers,
  qualityLabel,
  rangeLabel,
  requestKey,
  isSettingsError,
  ruleChanges,
  ruleLabel,
  ruleSummary,
  selectedPreset,
  sessionCount,
  setupSummary,
  signedPercent,
  signedPoints,
  sortSymbolRows,
  symbolPresets,
  symbolRows,
  unscoredReasons,
  verdictRows,
  type RunRequest,
} from "../apps/web/src/backtest-model.js";
import { groupAlertDays } from "../apps/web/src/live-model.js";

// SYNTHETIC fixtures: shapes match the API, numbers are invented.
const outcome = (
  result: Outcome["result"],
  runUnits: number | null = 1,
): Outcome => ({
  result,
  reason: result === "unscored" ? "Entry outside regular hours" : undefined,
  entry: result === "unscored" ? null : 100,
  entryAt: null,
  unit: result === "unscored" ? null : 0.5,
  minutes: null,
  run: null,
  pullback: null,
  runUnits: result === "unscored" ? null : runUnits,
  forward: { 5: null, 15: null, 30: null, 60: null },
});

let minute = 0;
const alert = (
  ticker: string,
  result: Outcome["result"],
  runUnits = 1,
): BacktestAlert =>
  ({
    ticker,
    end: new Date(Date.UTC(2026, 9, 2, 14, minute++)).toISOString(),
    session: "regular",
    ratio: 3,
    move: 1,
    direction: "up",
    outcome: outcome(result, runUnits),
  }) as unknown as BacktestAlert;

const summary = (over: Partial<ValidationSummary> = {}): ValidationSummary => ({
  config: validationDefaults,
  scored: 0,
  unscored: 0,
  good: 0,
  stopped: 0,
  weak: 0,
  medianRunUnits: null,
  medianMinutesToGood: null,
  medianForward: { 5: null, 15: null, 30: null, 60: null },
  baseline: { scored: 0, good: 0, stopped: 0, weak: 0 },
  ...over,
});

test("rule changes: one changed field gives the badge and title suffix (scenario 1)", () => {
  const changed = { ...liveSettings, threshold: 2.5 };
  assert.deepEqual(ruleChanges(changed), ["threshold"]);
  assert.equal(changeBadge(1), "1 change from live");
  assert.equal(changeBadge(3), "3 changes from live");
  assert.equal(changeBadge(0), "Live settings");
  assert.equal(ruleLabel(1), "rvol-v4 + 1 change");
  assert.equal(ruleLabel(0), "rvol-v4");
  // Reset = the live settings again.
  assert.deepEqual(ruleChanges({ ...liveSettings }), []);
});

test("rule summary is generated from the values", () => {
  const live = ruleSummary();
  assert.match(live, /volume ≥ 3× typical/);
  assert.match(live, /≥ 0\.5%/);
  assert.match(live, /1 candle in the move's direction/);
  assert.match(live, /15 min cooldown/);
  assert.doesNotMatch(live, /today's volume level/);
  assert.match(
    ruleSummary({ ...liveSettings, todayVolumeMultiple: 1.5 }),
    /burst ≥ 1\.5× today's volume level/,
  );
});

test("dates: last N sessions end on the last complete session, skipping weekends and holidays (scenario 2)", () => {
  // Saturday 3 Oct 2026: last complete session is Friday 2 Oct.
  const saturday = Date.parse("2026-10-03T12:00:00Z");
  assert.deepEqual(lastSessions(10, saturday), {
    from: "2026-09-21",
    to: "2026-10-02",
  });
  // Friday 19:59 New York: Friday's after-hours are still open.
  assert.equal(
    lastCompleteSession(Date.parse("2026-10-02T23:59:00Z")),
    "2026-10-01",
  );
  assert.equal(
    lastCompleteSession(Date.parse("2026-10-03T00:00:00Z")),
    "2026-10-02",
  );
  // Labor Day (7 Sep 2026) is skipped.
  assert.deepEqual(lastSessions(5, Date.parse("2026-09-10T12:00:00Z")), {
    from: "2026-09-02",
    to: "2026-09-09",
  });
  assert.equal(sessionCount("2026-09-02", "2026-09-09"), 5);
  assert.equal(sessionCount("2023-12-01", "2024-01-05"), null);
  assert.equal(datePreset("2026-09-21", "2026-10-02", saturday), 10);
  assert.equal(datePreset("2026-09-22", "2026-10-02", saturday), "custom");
  assert.equal(lastSessions(5, Date.parse("2030-01-10T12:00:00Z")), null);
  // Same date style as the Live day labels (ICU may print "Sept").
  assert.match(
    rangeLabel("2026-09-25", "2026-10-02"),
    /^Fri 25 Sept? – Fri 2 Oct$/,
  );
});

test("symbol presets: alerted recently is disabled without live alerts (scenario 3)", () => {
  const list = {
    tickers: ["NVDA", "AMD", "TSLA", "MSTR"],
    benchmarks: { NVDA: "SMH", AMD: "SMH", MSTR: "IBIT" },
  };
  const presets = symbolPresets(list, []);
  assert.deepEqual(
    presets.map((p) => [p.label, p.tickers, p.disabled]),
    [
      ["Whole watchlist", ["NVDA", "AMD", "TSLA", "MSTR"], null],
      ["Alerted recently", [], "No recent live alerts"],
      ["IBIT", ["MSTR"], null],
      ["SMH", ["NVDA", "AMD"], null],
    ],
  );
  const live = symbolPresets(list, [{ ticker: "TSLA" }, { ticker: "TSLA" }]);
  assert.deepEqual(live[1]!.tickers, ["TSLA"]);
  assert.equal(live[1]!.disabled, null);
  assert.equal(selectedPreset(live, ["AMD", "NVDA"]), "sector:SMH");
  assert.equal(selectedPreset(live, ["AMD"]), null);
  assert.equal(
    previewTickers(Array.from({ length: 30 }, (_, i) => `S${i}`)),
    "S0, S1, S2, S3, S4, S5, S6, S7 +22 more",
  );
});

test("verdict: points vs baseline coloured by whether they are better (scenario 4)", () => {
  const s = summary({
    scored: 100,
    good: 32,
    stopped: 41,
    weak: 27,
    baseline: { scored: 1000, good: 300, stopped: 440, weak: 260 },
  });
  const [good, stopped, weak] = verdictRows(s);
  assert.deepEqual(good, {
    key: "good",
    alerts: 32,
    baseline: 30,
    diff: 2,
    tone: "better",
  });
  assert.equal(stopped!.diff, -3);
  assert.equal(stopped!.tone, "better");
  assert.equal(weak!.tone, "neutral");
  assert.equal(signedPoints(2), "+2 pts");
  assert.equal(signedPoints(-3), "−3 pts");
  assert.equal(signedPercent(-0.001), "0.00%");
  assert.equal(signedPercent(0.123), "+0.12%");
  assert.equal(signedPercent(-0.4), "−0.40%");
  const worse = verdictRows(
    summary({
      scored: 40,
      good: 10,
      stopped: 20,
      weak: 10,
      baseline: { scored: 100, good: 30, stopped: 40, weak: 30 },
    }),
  );
  assert.equal(worse[0]!.tone, "worse");
  assert.equal(worse[1]!.tone, "worse");
  assert.ok(84 >= minTrusted && 40 < minTrusted);
  assert.equal(verdictRows(summary())[0]!.diff, null);
});

// SYNTHETIC look-now scores on an alert.
const scored = (a: BacktestAlert, score: number | null): BacktestAlert => ({
  ...a,
  lookNow: {
    score,
    label:
      score === null
        ? null
        : score >= 97
          ? "very-big"
          : score >= 90
            ? "big"
            : "normal",
    reason: score === null ? "Outside regular hours" : undefined,
    horizons: [],
    peak: score === null ? null : 15,
    withBurst: score === null ? null : score > 50,
    nearClose: false,
    beta: 1,
    betaAssumed: false,
  },
});

test("by symbol: average look-now score first, trade view vs its own baseline, small symbols last (scenarios 5, 6)", () => {
  const alerts = [
    ...(["good", "good", "good", "weak", "stopped", "stopped"] as const).map(
      (r, i) => scored(alert("NVDA", r), [98, 92, 60, 50, 40, 30][i]!),
    ),
    ...(["good", "good", "good", "good"] as const).map((r) =>
      scored(alert("COIN", r), 99),
    ),
    ...(
      ["good", "stopped", "stopped", "weak", "good", "unscored"] as const
    ).map((r, i) => scored(alert("AMD", r), [80, 80, 80, 80, 80, null][i]!)),
  ];
  const rows = symbolRows(alerts, {
    NVDA: { scored: 100, good: 40, stopped: 30, weak: 30 },
    COIN: { scored: 0, good: 0, stopped: 0, weak: 0 },
  });
  const sorted = sortSymbolRows(rows, "avgScore", true);
  assert.deepEqual(
    sorted.map((r) => [
      r.ticker,
      Math.round(r.avgScore!),
      r.bigShare,
      r.goodPct,
      r.vsBaseline,
      r.small,
    ]),
    [
      ["AMD", 80, 0, 40, null, false], // no baseline key: "—"
      ["NVDA", 62, 33, 50, 10, false],
      ["COIN", 99, 100, 100, null, true], // 4 scored: faded and last
    ],
  );
  assert.equal(rows.find((r) => r.ticker === "AMD")!.alerts, 6);
  assert.equal(rows.find((r) => r.ticker === "AMD")!.lookScored, 5);
  // Ascending still keeps the small symbol last.
  assert.equal(sortSymbolRows(rows, "avgScore", false).at(-1)!.ticker, "COIN");
  assert.equal(sortSymbolRows(rows, "goodPct", true)[0]!.ticker, "NVDA");
  assert.deepEqual(
    symbolRows(alerts).map((r) => r.vsBaseline),
    [null, null, null],
  );
  // Older API without look-now: every symbol is faded, scores "—".
  assert.deepEqual(
    symbolRows([alert("X", "good")]).map((r) => [r.avgScore, r.small]),
    [[null, true]],
  );
});

test("alerts tab helpers: look-now counts, day header, peak, sorts", () => {
  const alerts = [
    scored(alert("NVDA", "good", 2.5), 98),
    scored(alert("NVDA", "stopped", 0.2), 91),
    scored(alert("AMD", "weak", 1.1), 40),
    scored(alert("AMD", "unscored"), null),
  ];
  assert.deepEqual(lookCounts(alerts, null), {
    all: 4,
    "very-big": 1,
    big: 1,
    normal: 1,
    unscored: 1,
  });
  assert.equal(lookCounts(alerts, "AMD").all, 2);
  assert.deepEqual(
    filterLook(alerts, "unscored").map((a) => a.ticker),
    ["AMD"],
  );
  assert.equal(dayScoreLabel(alerts), "4 alerts · avg score 76");
  assert.equal(peakLabel(alerts[0]!.lookNow), "Peak 15 min · with burst");
  assert.equal(peakLabel(alerts[2]!.lookNow), "Peak 15 min · against burst");
  assert.equal(peakLabel(alerts[3]!.lookNow), "—");
  assert.equal(
    peakLabel({ score: 90, peak: "close", withBurst: null }),
    "Peak close",
  );
  const [byScore] = groupAlertDays(alerts, "score");
  assert.deepEqual(
    byScore!.groups[0]!.rows.map((a) => a.lookNow?.score),
    [98, 91, 40, null],
  );
  const [byRun] = groupAlertDays(alerts, "run");
  assert.deepEqual(
    byRun!.groups[0]!.rows.map((a) => a.outcome?.runUnits),
    [2.5, 1.1, 0.2, null],
  );
  assert.deepEqual(unscoredReasons(alerts), [
    ["Entry outside regular hours", 1],
  ]);
});

const part = (
  tickers: string[],
  alerts: BacktestAlert[],
  bySymbol?: ValidationSummary["baselineBySymbol"],
  over: Partial<BacktestResult> = {},
): BacktestResult =>
  // Older APIs omit lookNow; the cast keeps it optional here.
  ({
    source: "alpaca",
    feed: "sip",
    tickers,
    from: "2026-09-28",
    to: "2026-10-02",
    config: {} as BacktestResult["config"],
    evaluated: 1000,
    alerts,
    diagnostics: { "below-threshold": 900, alert: alerts.length },
    coverage: tickers.map((ticker) => ({
      ticker,
      bars: 4000,
      missingSessions: [],
    })),
    validation: summary({
      baseline: { scored: 10, good: 3, stopped: 4, weak: 3 },
      ...(bySymbol ? { baselineBySymbol: bySymbol } : {}),
    }),
    ...over,
  }) as BacktestResult;

test("batch merge adds counts, merges per-symbol baselines and recomputes the summary (scenario 7)", () => {
  const a = part(["NVDA"], [alert("NVDA", "good")], {
    NVDA: { scored: 10, good: 3, stopped: 4, weak: 3 },
  });
  const b = part(["AMD"], [alert("AMD", "stopped")], {
    AMD: { scored: 10, good: 3, stopped: 4, weak: 3 },
  });
  const merged = mergeResults([a, b]);
  assert.deepEqual(merged.tickers, ["NVDA", "AMD"]);
  assert.equal(merged.evaluated, 2000);
  assert.equal(merged.validation.scored, 2);
  assert.equal(merged.validation.good, 1);
  assert.deepEqual(merged.validation.baseline, {
    scored: 20,
    good: 6,
    stopped: 8,
    weak: 6,
  });
  assert.deepEqual(Object.keys(merged.validation.baselineBySymbol!), [
    "NVDA",
    "AMD",
  ]);
  assert.equal(merged.diagnostics["below-threshold"], 1800);
  // A retried batch merged into the earlier result updates the totals.
  const retried = mergeResults([
    merged,
    part(["TSLA"], [alert("TSLA", "good")]),
  ]);
  assert.equal(retried.alerts.length, 3);
  assert.equal(retried.validation.baseline.scored, 30);
  assert.equal(retried.coverage.length, 3);
  // Look-now: alert stats recomputed, random-minute baselines weighted.
  const look = (score: number | null) => ({
    score,
    label: score === null ? null : score >= 90 ? "big" : "normal",
    reason: score === null ? "Outside regular hours" : undefined,
    horizons: [],
    peak: score === null ? null : 5,
    withBurst: score === null ? null : true,
    nearClose: false,
    beta: 1,
    betaAssumed: false,
  });
  const withLook = (t: string, score: number | null, avg: number) => {
    const a = alert(t, "good");
    (a as { lookNow: unknown }).lookNow = look(score);
    return part([t], [a], undefined, {
      lookNow: {
        scored: 1,
        unscored: 0,
        reasons: {},
        averageScore: score,
        big: 0,
        veryBig: 0,
        withBurst: 1,
        peaks: {},
        baseline: {
          scored: avg === 50 ? 100 : 300,
          averageScore: avg,
          big: 4,
          veryBig: 1,
        },
      } as BacktestResult["lookNow"],
    });
  };
  const looked = mergeResults([withLook("A", 95, 50), withLook("B", null, 54)]);
  assert.equal(looked.lookNow.scored, 1);
  assert.equal(looked.lookNow.unscored, 1);
  assert.equal(looked.lookNow.big, 1);
  assert.deepEqual(looked.lookNow.reasons, { "Outside regular hours": 1 });
  assert.deepEqual(looked.lookNow.baseline, {
    scored: 400,
    averageScore: 53,
    big: 8,
    veryBig: 2,
  });
  assert.equal(mergeResults([part(["X"], [])]).lookNow, undefined);
  // Older API: no per-symbol map anywhere stays absent.
  assert.equal(
    mergeResults([part(["X"], []), part(["Y"], [])]).validation
      .baselineBySymbol,
    undefined,
  );
});

test("data quality label and log-scale diagnostics", () => {
  const ok = part(["NVDA"], []);
  assert.equal(qualityLabel(ok, []), "OK");
  const gap = part(["NVDA"], [], undefined, {
    coverage: [{ ticker: "NVDA", bars: 10, missingSessions: ["2026-09-28"] }],
  });
  assert.equal(qualityLabel(gap, []), "1 gap");
  const fail = [{ tickers: ["HOOD"], error: "Timed out" }];
  assert.equal(qualityLabel(ok, fail), "1 failed");
  assert.equal(qualityLabel(gap, fail), "2 issues");
  assert.equal(qualityLabel(null, fail), "1 failed");
  assert.equal(isSettingsError("Invalid threshold"), true);
  assert.equal(isSettingsError("Choose at most 20 trading sessions"), true);
  assert.equal(isSettingsError("Timed out"), false);
  const bars = diagnosticBars({
    "small-move": 10,
    "below-threshold": 999999,
    cooldown: 0,
  });
  assert.deepEqual(
    bars.map((b) => [b.label, Math.round(b.width)]),
    [
      ["Volume below threshold", 100],
      ["Move too small", 17],
    ],
  );
});

test("settings key ignores symbol order; setup summary", () => {
  const r: RunRequest = {
    tickers: ["NVDA", "AMD"],
    from: "2026-09-28",
    to: "2026-10-02",
    config: liveSettings,
    validation: { stopUnits: 1, goodUnits: 2, horizon: 60 },
  };
  assert.equal(requestKey(r), requestKey({ ...r, tickers: ["AMD", "NVDA"] }));
  assert.notEqual(
    requestKey(r),
    requestKey({ ...r, config: { ...liveSettings, threshold: 2.5 } }),
  );
  assert.equal(
    setupSummary(30, 5, 1),
    "Setup · 30 symbols · 5 sessions · rvol-v4 + 1 change",
  );
});
