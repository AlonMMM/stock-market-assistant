// SYNTHETIC market data: marked-sections score vs SPY
// (docs/features/marks-vs-spy.md, acceptance scenarios 1–6, and the alert =
// chart check of scenario 7 on the backend side).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  byDate,
  dayMarks,
  daySeries,
  historyMarks,
  marksAt,
  marksScore,
  marksSeries,
  normalCdf,
  previousCloseOf,
  sigmaCurve,
  type DayMarks,
  type MarkBar,
  type MarksSigma,
} from "../packages/market-data/src/marks-vs-spy.js";
import { alertVsSpy } from "../packages/market-data/src/alert-vs-spy.js";
import {
  newYorkToUtc,
  previousSessions,
} from "../packages/market-data/src/calendar.js";
import type { ChartSeries } from "../packages/market-data/src/day-chart.js";
import {
  marksAlertEnd,
  marksScoreAt,
  marksWeight,
  vsSpyLine,
} from "../packages/contracts/src/vs-spy.js";

const day = "2026-09-28";
const open = newYorkToUtc(day, 570) / 1000;
const near = (a: number | null, b: number, eps = 1e-9) =>
  assert.ok(a !== null && Math.abs(a - b) < eps, `${a} ≈ ${b}`);

/** Regular bars from 09:30, one per minute k, close = closes[k]. */
const bars = (closes: number[], date = day): MarkBar[] => {
  const start = newYorkToUtc(date, 570) / 1000;
  return closes.map((close, k) => ({
    date,
    start: start + 60 * k,
    session: "regular",
    open: close,
    close,
    volume: 100,
  }));
};
const series = (ticker: string, closes: number[]): ChartSeries => ({
  ticker,
  previousClose: 100,
  bars: bars(closes),
});
const flat = (n: number, level = 100) => new Array<number>(n).fill(level);
/** SPY flat at 100 except a one-minute dip to `level` at minute `k`. */
const dip = (n: number, k: number, level: number) =>
  flat(n).map((c, i) => (i === k ? level : c));
const marks = (stock: number[], spy: number[]) =>
  dayMarks(series("AVGO", stock), series("SPY", spy), day);
const constant = (sigma: number): MarksSigma => new Array(390).fill(sigma);

test("Φ and the score: round(100 · Φ(I / σ))", () => {
  near(normalCdf(0), 0.5, 1e-7);
  near(normalCdf(1), 0.8413447, 1e-6);
  near(normalCdf(-1.96), 0.0249979, 1e-6);
  assert.equal(marksScore(1, 1), 84);
  assert.equal(marksScore(0, 0.3), 50);
  assert.equal(marksScore(1, 0), null);
  assert.equal(marksScore(1, null), null);
  assert.equal(marksScore(null, 1), null);
});

test("marks come from opposite(): one green minute with its moves", () => {
  const m = marks(flat(200), dip(200, 100, 99.5));
  assert.deepEqual(
    m.mark.flatMap((s, k) => (s ? [[k, s]] : [])),
    [[100, "strong"]],
  );
  near(m.tR[100]!, 0);
  near(m.bR[100]!, -0.5);
  assert.equal(m.stockFirst, 0);
  assert.equal(m.stockLast, 199);
  assert.equal(m.spyFirst, 0);
});

test("scenario 1: no marks in the 60 minutes before E → 50", () => {
  const m = marks(flat(200), flat(200));
  const v = marksAt("AVGO", m, 570 + 150, 1.3, constant(0.4));
  assert.equal(v.sum, 0);
  assert.equal(v.score, 50);
});

test("scenario 2: green mark, SPY −0.50, stock 0, β 2 → c = +1.00; newer weighs more", () => {
  const m = marks(flat(200), dip(200, 100, 99.5));
  // E one minute after the mark: w = 59/60.
  const recent = marksAt("AVGO", m, 570 + 101, 2, constant(1));
  near(recent.sum, (1.0 * 59) / 60);
  // E 50 minutes after the mark: w = 10/60.
  const old = marksAt("AVGO", m, 570 + 150, 2, constant(1));
  near(old.sum, (1.0 * 10) / 60);
  assert.ok(recent.score! > old.score!, `${recent.score} > ${old.score}`);
  near(marksWeight(open + 60 * 101, open + 60 * 100), 59 / 60);
  near(marksWeight(open + 60 * 150, open + 60 * 100), 10 / 60);
  // The newest minute weighs 1.
  near(marksAt("AVGO", m, 570 + 100, 2, constant(1)).sum, 1);
});

test("scenario 3: SPY −0.05 vs −0.50, stock flat, β 1 → c 0.05 vs 0.50", () => {
  const small = marksSeries(
    "AVGO",
    marks(flat(120), dip(120, 100, 99.95)),
    1,
    false,
    null,
  );
  const large = marksSeries(
    "AVGO",
    marks(flat(120), dip(120, 100, 99.5)),
    1,
    false,
    null,
  );
  near(small.contribution[100]!, 0.05);
  near(large.contribution[100]!, 0.5);
  assert.equal(small.contribution[99], null);
  assert.equal(small.mark[100], "strong");
});

/**
 * A ▼ alert at minute 110 (window 3: own minutes 108–110) after a green mark
 * at minute 60. The stock ticks 100 / 100.02 so its usual 5-minute move is
 * 0.02; it falls 0.5 % at 108–110 while SPY is flat → three red marks.
 */
function alertDay() {
  const stock = Array.from({ length: 111 }, (_, k) =>
    k >= 108 ? 99.6 - 0.1 * (k - 108) : k % 2 ? 100 : 100.02,
  );
  const spy = dip(111, 60, 99.5);
  return { stock, spy };
}

test("scenario 4: the alert's own red minutes are excluded; earlier green decides", () => {
  const { stock, spy } = alertDay();
  const m = marks(stock, spy);
  assert.deepEqual(
    m.mark.flatMap((s, k) => (s ? [[k, s]] : [])),
    [
      [60, "strong"],
      [108, "weak"],
      [109, "weak"],
      [110, "weak"],
    ],
  );
  const sigma = constant(0.1);
  // At the alert bar itself the red minutes would dominate…
  const including = marksAt("AVGO", m, 570 + 110, 1, sigma);
  assert.ok(including.score! < 50, `${including.score}`);
  // …the alert's E = 110 − 3 = 107 leaves only the green mark (age 47).
  const vs = alertVsSpy({
    ticker: "AVGO",
    date: day,
    minute: 570 + 110,
    window: 3,
    stock: bars(stock),
    spy: bars(spy),
    beta: 1,
    betaAssumed: false,
    sigma,
  });
  near(vs.sum!, Number(((0.02 + 0.5) * (13 / 60)).toFixed(4)));
  assert.equal(vs.score, marksScore((0.02 + 0.5) * (13 / 60), 0.1));
  assert.ok(vs.score! >= 60, `${vs.score}`);
  assert.equal(vs.spyLagged, false);
  assert.equal(vsSpyLine(vs), `vs SPY ${vs.score}/100`);
});

test("scenario 5: marks 60 or more minutes before E contribute 0", () => {
  const m = marks(flat(200), dip(200, 100, 99.5));
  near(marksAt("AVGO", m, 570 + 159, 1, constant(1)).sum, 0.5 / 60);
  const v = marksAt("AVGO", m, 570 + 160, 1, constant(1));
  assert.equal(v.sum, 0);
  assert.equal(v.score, 50);
});

/** History of `n` sessions; the first has one green mark at minute 100. */
function history(n: number): {
  dates: string[];
  of: (d: string) => DayMarks | null;
} {
  const dates = previousSessions(day, 20);
  const m0 = marks(flat(390), dip(390, 100, 99.5));
  const quiet = marks(flat(390), flat(390));
  const have = dates.slice(-n);
  return {
    dates,
    of: (d) => (!have.includes(d) ? null : d === have[0] ? m0 : quiet),
  };
}

test("σ: RMS over sessions with data, unmarked sessions count as 0", () => {
  const h = history(15);
  const curve = sigmaCurve(h.of, h.dates, 2);
  assert.equal(curve.length, 390);
  // Only one session has I ≠ 0 at minute 100: I = 1.0 (c = 0 − 2·(−0.5)).
  near(curve[100]!, Number(Math.sqrt(1 / 15).toPrecision(4)));
  near(curve[130]!, Number(Math.sqrt((30 / 60) ** 2 / 15).toPrecision(4)));
  // No session has a mark there: σ = 0 → null → no score.
  assert.equal(curve[50], null);
  assert.equal(curve[160], null);
});

test("scenario 6: 14 of 20 prior sessions → —; pre-market alert → —", () => {
  const h = history(14);
  assert.ok(sigmaCurve(h.of, h.dates, 1).every((s) => s === null));
  const m = marks(flat(200), dip(200, 100, 99.5));
  assert.equal(
    marksAt("AVGO", m, 570 + 101, 1, sigmaCurve(h.of, h.dates, 1)).score,
    null,
  );
  const { stock, spy } = alertDay();
  const pre = alertVsSpy({
    ticker: "AVGO",
    date: day,
    minute: 500,
    window: 3,
    stock: bars(stock),
    spy: bars(spy),
    beta: 1,
    betaAssumed: false,
    sigma: constant(1),
  });
  assert.equal(pre.score, null);
  assert.equal(pre.sum, null);
  assert.equal(vsSpyLine(pre), "vs SPY —");
  // E inside the regular session but the alert bar in its first minutes:
  // 09:32 with window 3 → E = 09:29, before the open.
  const early = alertVsSpy({
    ticker: "AVGO",
    date: day,
    minute: 572,
    window: 3,
    stock: bars(stock),
    spy: bars(spy),
    beta: 1,
    betaAssumed: false,
    sigma: constant(1),
  });
  assert.equal(early.score, null);
});

test("null rules: SPY itself, no SPY data, before the stock's first bar", () => {
  const m = marks(flat(200), dip(200, 100, 99.5));
  assert.equal(marksAt("SPY", m, 600, 1, constant(1)).score, null);
  const noSpy = dayMarks(
    series("AVGO", flat(200)),
    { ticker: "SPY", previousClose: null, bars: [] },
    day,
  );
  assert.equal(marksAt("AVGO", noSpy, 650, 1, constant(1)).score, null);
  const late = dayMarks(
    { ticker: "AVGO", previousClose: 100, bars: bars(flat(200)).slice(30) },
    series("SPY", flat(200)),
    day,
  );
  assert.equal(marksAt("AVGO", late, 570 + 29, 1, constant(1)).score, null);
  assert.equal(marksAt("AVGO", late, 570 + 30, 1, constant(1)).score, 50);
  // After the regular session.
  assert.equal(marksAt("AVGO", m, 960, 1, constant(1)).score, null);
});

test("chart series: per-minute values equal the alert's at E (scenario 7, backend)", () => {
  const { stock, spy } = alertDay();
  const m = marks(stock, spy);
  const sigma = constant(0.1);
  const s = marksSeries("AVGO", m, 1.4, false, sigma);
  assert.equal(s.start, open);
  for (const key of ["contribution", "mark", "sum", "sigma", "score"] as const)
    assert.equal(s[key].length, 111, key);
  for (let k = 0; k < 111; k += 7)
    assert.equal(s.score[k], marksAt("AVGO", m, 570 + k, 1.4, sigma).score);
  const vs = alertVsSpy({
    ticker: "AVGO",
    date: day,
    minute: 570 + 110,
    window: 3,
    stock: bars(stock),
    spy: bars(spy),
    beta: 1.4,
    betaAssumed: false,
    sigma,
  });
  const alertEnd = new Date((open + 60 * 111) * 1000).toISOString();
  assert.equal(marksAlertEnd(alertEnd, 3), open + 60 * 107);
  assert.equal(marksScoreAt(s, marksAlertEnd(alertEnd, 3)), vs.score);
  assert.equal(marksScoreAt(s, open - 60), null);
  assert.equal(marksScoreAt(s, open + 60 * 111), null);
  // SPY itself: empty arrays.
  assert.equal(marksSeries("SPY", m, 1, true, sigma).score.length, 0);
});

test("history marks: previous close from the prior session, else the first open", () => {
  const prior = previousSessions(day, 1)[0]!;
  const priorBars = bars([101, 102], prior);
  const today = bars(flat(10, 103));
  const days = byDate([...today, ...priorBars]);
  assert.equal(previousCloseOf(days, day), 102);
  assert.equal(previousCloseOf(byDate(today), day), 103);
  assert.equal(daySeries("X", days, day).bars.length, 10);
  // No stock bars that day: the session is not counted.
  assert.equal(historyMarks("X", new Map(), days, day), null);
  assert.notEqual(historyMarks("X", days, days, day), null);
});
