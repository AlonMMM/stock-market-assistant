// SYNTHETIC market data: area score vs SPY (docs/features/area-vs-spy.md,
// acceptance scenarios 1–6).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  areaAt,
  areaScore,
  areaSeries,
  dayAreas,
  fromPriceBar,
  fromRawBars,
  normalCdf,
  sessionOf,
  sigmaAt,
  sigmaCurve,
  type AreaBar,
  type AreaInputs,
  type SigmaCurve,
} from "../packages/market-data/src/area-vs-spy.js";
import {
  newYorkToUtc,
  previousSessions,
} from "../packages/market-data/src/calendar.js";
import { vsSpyLine, vsSpyTone } from "../packages/contracts/src/vs-spy.js";
import { minuteBar } from "./analysis-fixtures.js";

const day = "2026-09-28";
const near = (a: number | null, b: number, eps = 1e-9) =>
  assert.ok(a !== null && Math.abs(a - b) < eps, `${a} ≈ ${b}`);

const bar = (
  minute: number,
  close: number,
  open = close,
  date = day,
): AreaBar => ({
  date,
  minute,
  session: sessionOf(date, minute),
  open,
  close,
});
/** One bar per minute from `from` to `to` (inclusive), close = f(minute). */
const run = (from: number, to: number, f: (t: number) => number, date = day) =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    bar(from + i, f(from + i), i === 0 ? 100 : f(from + i), date),
  );
const flat = (from: number, to: number, level = 100, date = day) =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    bar(from + i, level, level, date),
  );
/** σ curve with the same value at every minute. */
const constantSigma = (sigma: number): SigmaCurve => ({
  pre: new Array(330).fill(sigma),
  regular: new Array(390).fill(sigma),
  post: new Array(240).fill(sigma),
});
const inputs = (over: Partial<AreaInputs>): AreaInputs => ({
  ticker: "NVDA",
  stock: [],
  spy: [],
  date: day,
  beta: 1,
  sigma: constantSigma(1),
  ...over,
});

test("Φ: the erf approximation matches known values", () => {
  near(normalCdf(0), 0.5, 1e-7);
  near(normalCdf(1), 0.8413447, 1e-6);
  near(normalCdf(-1), 0.1586553, 1e-6);
  near(normalCdf(1.96), 0.9750021, 1e-6);
  near(normalCdf(-3), 0.0013499, 1e-6);
  assert.equal(areaScore(1, 1), 84);
  assert.equal(areaScore(-1, 1), 16);
  assert.equal(areaScore(0, 0.3), 50);
  assert.equal(areaScore(1, null), null);
  assert.equal(areaScore(null, 1), null);
  assert.equal(areaScore(1, 0), null);
});

test("scenario 1: stock and SPY move identically with β 1 → 50", () => {
  const path = (t: number) => 100 + Math.sin(t / 7) * 2;
  const spy = run(570, 630, (t) => path(t) * 5).map((b, i) =>
    i === 0 ? { ...b, open: 500 } : b,
  );
  const stock = run(570, 630, path);
  const v = areaAt(inputs({ stock, spy }), 630);
  near(v.area, 0, 1e-9);
  near(v.gap, 0, 1e-9);
  assert.equal(v.score, 50);
});

test("scenario 2: 1 pt above β·SPY all window, σ 1 → round(100·Φ(1)) = 84", () => {
  const spy = flat(570, 630, 500);
  const stock = run(570, 630, () => 101); // opens 100, closes 101: +1%
  const v = areaAt(inputs({ stock, spy }), 630);
  near(v.area, 1);
  assert.equal(v.sigma, 1);
  assert.equal(v.score, 84);
  // β scales SPY's move: SPY +1% with β 2 needs the stock +3% for gap 1.
  const spyUp = run(570, 630, () => 101);
  const stockUp = run(570, 630, () => 103);
  const b = areaAt(inputs({ stock: stockUp, spy: spyUp, beta: 2 }), 630);
  near(b.area, 1);
  assert.equal(b.score, 84);
});

test("scenario 3: the same gap late in the window scores higher than early", () => {
  const spy = flat(570, 629, 500);
  // 60 minutes; +1 pt in the last 10 vs the first 10.
  const late = run(570, 629, (t) => (t >= 620 ? 101 : 100));
  const early = run(570, 629, (t) => (t < 580 ? 101 : 100));
  const a = areaAt(inputs({ stock: late, spy }), 629);
  const b = areaAt(inputs({ stock: early, spy }), 629);
  // Weights 1…60: late Σ51..60 = 555, early Σ1..10 = 55, of Σ1..60 = 1830.
  near(a.area, 555 / 1830);
  near(b.area, 55 / 1830);
  assert.ok(a.score! > b.score!, `${a.score} > ${b.score}`);
});

test("scenario 4: a final drop matching β·SPY's drop keeps the score high", () => {
  // NVDA-like: β 2, stock 2 pt above β·SPY all session; in the last three
  // minutes SPY drops 0.5% and the stock drops by β × that.
  const end = 959;
  const spyMove = (t: number) =>
    t > end - 3 ? -0.5 * ((t - (end - 3)) / 3) : 0;
  const spy = run(570, end, (t) => 500 * (1 + spyMove(t) / 100)).map((b, i) =>
    i === 0 ? { ...b, open: 500 } : b,
  );
  const stock = run(570, end, (t) => 100 * (1 + (2 + 2 * spyMove(t)) / 100));
  const before = areaAt(inputs({ stock, spy, beta: 2 }), end - 3);
  const after = areaAt(inputs({ stock, spy, beta: 2 }), end);
  near(after.gap, 2, 1e-9); // the drop adds no gap
  near(after.area, 2, 1e-9);
  assert.equal(after.score, before.score);
  assert.equal(after.score, 98); // round(100 · Φ(2))
});

test("scenario 5: σ is the RMS of past areas at the same minute; 14 of 20 sessions → —", () => {
  const prior = previousSessions(day, 20);
  // Past days: gap +1 on half, −2 on the other half, all regular session.
  const history = (dates: string[]) => {
    const stock: AreaBar[] = [];
    const spy: AreaBar[] = [];
    dates.forEach((date, i) => {
      const level = i % 2 ? 98 : 101;
      stock.push(...run(570, 700, () => level, date));
      spy.push(...flat(570, 700, 500, date));
    });
    return { stock, spy };
  };
  const full = history(prior);
  const curve = sigmaCurve(full.stock, full.spy, prior, 1);
  near(sigmaAt(curve, "regular", 650), Math.sqrt(2.5), 1e-3);
  assert.equal(sigmaAt(curve, "regular", 701), null, "no past bars there");
  assert.equal(sigmaAt(curve, "pre", 400), null);

  const fourteen = history(prior.slice(6));
  const sparse = sigmaCurve(fourteen.stock, fourteen.spy, prior, 1);
  assert.equal(sigmaAt(sparse, "regular", 650), null);
  const stock = run(570, 650, () => 101);
  const spy = flat(570, 650, 500);
  assert.equal(areaAt(inputs({ stock, spy, sigma: sparse }), 650).score, null);
  // Fifteen sessions are enough.
  const fifteen = history(prior.slice(5));
  const enough = sigmaCurve(fifteen.stock, fifteen.spy, prior, 1);
  assert.notEqual(sigmaAt(enough, "regular", 650), null);
  // Only the last 20 dates count, and only the dates passed (no look-ahead).
  const withToday = history([...prior, day]);
  assert.deepEqual(sigmaCurve(withToday.stock, withToday.spy, prior, 1), curve);
});

test("scenario 6: a pre-market alert's window starts at the pre-market's first bar", () => {
  // SPY rises 04:00–06:59, then is flat; the stock starts trading at 07:00.
  const spy = [
    ...run(240, 419, (t) => 500 + (t - 240) / 36).map((b, i) =>
      i === 0 ? { ...b, open: 500 } : b,
    ),
    ...flat(420, 480, 505),
  ];
  const stock = flat(420, 480, 100);
  const v = areaAt(inputs({ stock, spy }), 480);
  near(v.area, 0, 1e-12); // SPY's base is its 07:00 open, not 04:00
  assert.equal(v.score, 50);
  const series = areaSeries(inputs({ stock, spy }), stock);
  assert.deepEqual(series.windows, [
    { session: "pre", start: newYorkToUtc(day, 420) / 1000 },
  ]);
});

test("missing minutes carry the last close forward, never before the first bar", () => {
  const spy = flat(570, 600, 500);
  const full = run(570, 600, () => 101);
  const gappy = [bar(570, 101, 100), bar(590, 101)];
  assert.deepEqual(
    areaAt(inputs({ stock: gappy, spy }), 600),
    areaAt(inputs({ stock: full, spy }), 600),
  );
  // The stock's first regular bar is at 09:35: minutes before it add nothing.
  const late = [bar(575, 101, 100), ...run(576, 600, () => 101).slice(1)];
  const [w] = dayAreas(late, spy, day);
  assert.equal(w!.start, 570);
  assert.ok(Number.isNaN(w!.S[4]!));
  near(w!.S[5]!, 1);
  near(areaAt(inputs({ stock: late, spy }), 600).area, 1);
  // SPY missing at T (lagged): its last close is carried.
  const lagging = flat(570, 590, 500);
  near(areaAt(inputs({ stock: full, spy: lagging }), 600).area, 1);
});

test("no future data: bars after T change nothing, and the chart matches the alert", () => {
  const spy = run(570, 700, (t) => 500 + Math.cos(t / 5));
  const stock = run(570, 700, (t) => 100 + Math.sin(t / 9));
  const cut = (bars: AreaBar[]) => bars.filter((b) => b.minute <= 640);
  const at = areaAt(inputs({ stock, spy, beta: 1.3 }), 640);
  assert.deepEqual(
    at,
    areaAt(inputs({ stock: cut(stock), spy: cut(spy), beta: 1.3 }), 640),
  );
  const series = areaSeries(inputs({ stock, spy, beta: 1.3 }), stock);
  const i = stock.findIndex((b) => b.minute === 640);
  assert.equal(series.score[i], at.score);
  assert.equal(series.area[i], at.area);
  assert.equal(series.gap[i], at.gap);
});

test("null rules: first 5 minutes, SPY itself, no SPY data, no σ", () => {
  const spy = flat(570, 600, 500);
  const stock = run(570, 600, () => 101);
  // 09:30–09:34 is 5 minutes: too short; 09:35 has 6.
  assert.equal(areaAt(inputs({ stock, spy }), 574).score, null);
  near(areaAt(inputs({ stock, spy }), 574).area, 1);
  assert.equal(areaAt(inputs({ stock, spy }), 575).score, 84);
  const series = areaSeries(inputs({ stock, spy }), stock);
  assert.deepEqual(series.score.slice(0, 6), [
    null,
    null,
    null,
    null,
    null,
    84,
  ]);
  assert.deepEqual(areaAt(inputs({ ticker: "SPY", stock, spy }), 600), {
    gap: null,
    area: null,
    sigma: null,
    score: null,
  });
  assert.equal(areaAt(inputs({ stock, spy: [] }), 600).score, null);
  assert.equal(areaAt(inputs({ stock, spy, sigma: null }), 600).score, null);
  // After-hours window starts at the regular close.
  const post = run(960, 1000, () => 101);
  const postSpy = flat(960, 1000, 500);
  const [w] = dayAreas([...stock, ...post], [...spy, ...postSpy], day).filter(
    (x) => x.session === "post",
  );
  assert.equal(w!.start, 960);
  assert.equal(
    areaAt(inputs({ stock: [...stock, ...post], spy: postSpy }), 1000).score,
    84,
  );
});

test("bars from Alpaca rows and stored PriceBars use start minutes", () => {
  const p = minuteBar("NVDA", day, 630, 101);
  assert.deepEqual(fromPriceBar(p), {
    date: day,
    minute: 630,
    session: "regular",
    open: 101,
    close: 101,
  });
  const raw = {
    start: newYorkToUtc(day, 630) / 1000,
    open: 100,
    high: 101,
    low: 100,
    close: 101,
    volume: 5,
  };
  assert.deepEqual(fromRawBars("NVDA", [raw]), [
    { date: day, minute: 630, session: "regular", open: 100, close: 101 },
  ]);
});

test("Telegram line and colour words carry no labels", () => {
  assert.equal(vsSpyLine({ score: 72 }), "vs SPY 72/100");
  assert.equal(vsSpyLine({ score: null }), "vs SPY —");
  assert.equal(vsSpyLine(undefined), "vs SPY —");
  assert.equal(vsSpyTone(60), "stronger");
  assert.equal(vsSpyTone(59), "normal");
  assert.equal(vsSpyTone(41), "normal");
  assert.equal(vsSpyTone(40), "weaker");
  assert.equal(vsSpyTone(null), "none");
});
