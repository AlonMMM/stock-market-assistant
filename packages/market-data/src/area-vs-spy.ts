// Area score vs SPY (docs/features/area-vs-spy.md). Pure: the collector, the
// day chart, the board and the backtest share it.
//
// For a symbol, a session date and an end minute T:
//   window  first bar of T's session (regular 09:30, pre-market the stock's
//           first pre-market bar, after-hours the regular close) through T
//   s(t)    = close_stock(t) / open_stock(t0) − 1, %; m(t) the same for SPY;
//           missing minutes carry the last close forward (never before the
//           series' first bar in the window)
//   gap(t)  = s(t) − β · m(t)
//   A       = Σ w(t) · gap(t) / Σ w(t), w(t) = t − t0 + 1 (the spec's
//           (t − t0 + 1) / (T − t0 + 1) ramp; the constant cancels)
//   σ       = RMS of A at the same New York minute and session over the
//           previous 20 sessions (≥ 15 needed)
//   score   = round(100 · Φ(A / σ))
// Because gap is linear in β, A = S − β · M with S and M the weighted means of
// s and m alone; history is computed once per day without β.
import { normalize, type PriceBar, type RawBar } from "./bars.js";
import { coreClose, newYorkToUtc } from "./calendar.js";

export type Session = "pre" | "regular" | "post";
const sessions: Session[] = ["pre", "regular", "post"];

/** σ history: previous sessions examined and the minimum with a value. */
export const areaSigmaSessions = 20;
export const areaSigmaMinimum = 15;
/** A window of this many minutes or fewer is too short for a score. */
export const areaMinimumMinutes = 5;
/** First New York minute of each session's σ curve index. */
export const sessionBase: Record<Session, number> = {
  pre: 240,
  regular: 570,
  post: 960,
};
const sessionEnd: Record<Session, number> = {
  pre: 570,
  regular: 960,
  post: 1200,
};

/** One minute bar: New York date, start minute (09:30 = 570), session. */
export interface AreaBar {
  date: string;
  minute: number;
  session: Session;
  open: number;
  close: number;
}

export const fromPriceBar = (bar: PriceBar): AreaBar => ({
  date: bar.date,
  minute: bar.minute - 1, // PriceBar.minute is the bar's end minute
  session: bar.session,
  open: bar.open,
  close: bar.close,
});

/** Area bars from raw Alpaca rows (bars outside the sessions are dropped). */
export function fromRawBars(ticker: string, rows: RawBar[]): AreaBar[] {
  const result: AreaBar[] = [];
  for (const row of rows) {
    const bar = normalize(ticker, row, "shares");
    if (bar) result.push(fromPriceBar(bar));
  }
  return result;
}

/** Session of a New York start minute on a trading date. */
export function sessionOf(date: string, minute: number): Session {
  if (minute < 570) return "pre";
  return minute < (coreClose(date) ?? 960) ? "regular" : "post";
}

/**
 * Standard normal CDF via erf, Abramowitz & Stegun 7.1.26 (absolute error of
 * erf below 1.5e-7).
 */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** round(100 · Φ(A / σ)); null without both or with σ ≤ 0. */
export function areaScore(
  area: number | null | undefined,
  sigma: number | null | undefined,
): number | null {
  if (
    area === null ||
    area === undefined ||
    !Number.isFinite(area) ||
    sigma === null ||
    sigma === undefined ||
    !(sigma > 0)
  )
    return null;
  return Math.round(100 * normalCdf(area / sigma));
}

/**
 * One session window of one date, per minute t0 … end (index t − t0). NaN
 * where a series has no bar yet in the window. β-free: gap = s − β·m and
 * area = S − β·M.
 */
export interface AreaWindow {
  session: Session;
  start: number; // t0, New York start minute
  end: number; // last minute computed
  s: Float64Array; // stock % from its window base
  m: Float64Array; // SPY % from its window base
  S: Float64Array; // weighted mean of s over the window to t
  M: Float64Array; // weighted mean of m over the same minutes
}

const byMinute = (a: AreaBar, b: AreaBar) => a.minute - b.minute;

function window(
  session: Session,
  t0: number,
  end: number,
  stock: AreaBar[],
  spy: AreaBar[],
): AreaWindow {
  const n = end - t0 + 1;
  const w: AreaWindow = {
    session,
    start: t0,
    end,
    s: new Float64Array(n),
    m: new Float64Array(n),
    S: new Float64Array(n),
    M: new Float64Array(n),
  };
  let i = 0;
  let j = 0;
  while (i < stock.length && stock[i]!.minute < t0) i++;
  while (j < spy.length && spy[j]!.minute < t0) j++;
  let stockBase = NaN;
  let stockLast = NaN;
  let spyBase = NaN;
  let spyLast = NaN;
  let sumW = 0;
  let sumS = 0;
  let sumM = 0;
  for (let t = t0, k = 0; t <= end; t++, k++) {
    while (i < stock.length && stock[i]!.minute <= t) {
      if (Number.isNaN(stockBase)) stockBase = stock[i]!.open;
      stockLast = stock[i]!.close;
      i++;
    }
    while (j < spy.length && spy[j]!.minute <= t) {
      if (Number.isNaN(spyBase)) spyBase = spy[j]!.open;
      spyLast = spy[j]!.close;
      j++;
    }
    const s = (stockLast / stockBase - 1) * 100;
    const m = (spyLast / spyBase - 1) * 100;
    w.s[k] = s;
    w.m[k] = m;
    if (Number.isFinite(s) && Number.isFinite(m)) {
      const weight = k + 1;
      sumW += weight;
      sumS += weight * s;
      sumM += weight * m;
    }
    w.S[k] = sumW > 0 ? sumS / sumW : NaN;
    w.M[k] = sumW > 0 ? sumM / sumW : NaN;
  }
  return w;
}

/**
 * The session windows of `date` with stock bars, using only bars starting at
 * or before `until` (no future data). Each window runs to the latest minute
 * of either series in it (capped at `until`).
 */
export function dayAreas(
  stock: AreaBar[],
  spy: AreaBar[],
  date: string,
  until = Infinity,
): AreaWindow[] {
  const of = (bars: AreaBar[], session: Session) =>
    bars
      .filter(
        (b) => b.date === date && b.session === session && b.minute <= until,
      )
      .sort(byMinute);
  const result: AreaWindow[] = [];
  for (const session of sessions) {
    const a = of(stock, session);
    if (!a.length) continue;
    const b = of(spy, session);
    const t0 =
      session === "pre"
        ? a[0]!.minute
        : session === "regular"
          ? 570
          : (coreClose(date) ?? 960);
    const last = Math.max(a.at(-1)!.minute, b.at(-1)?.minute ?? -1);
    const end = Math.min(last, until, sessionEnd[session] - 1);
    if (end >= t0) result.push(window(session, t0, end, a, b));
  }
  return result;
}

const finite = (x: number) => (Number.isFinite(x) ? x : null);

/** σ per New York minute and session; index = minute − sessionBase. */
export interface SigmaCurve {
  pre: (number | null)[];
  regular: (number | null)[];
  post: (number | null)[];
}

/** Bars grouped by New York date. */
export function byDate(bars: AreaBar[]): Map<string, AreaBar[]> {
  const result = new Map<string, AreaBar[]>();
  for (const bar of bars) {
    const list = result.get(bar.date);
    if (list) list.push(bar);
    else result.set(bar.date, [bar]);
  }
  return result;
}

/**
 * σ curve for a scored date from the previous sessions `dates` (the last
 * `areaSigmaSessions` are used; pass only dates before the scored date):
 * RMS of A = S − β·M per minute and session over the sessions with a value
 * there; null with fewer than `areaSigmaMinimum`. Values keep 4 significant
 * digits (stored per day).
 */
export function sigmaCurve(
  stock: AreaBar[] | Map<string, AreaBar[]>,
  spy: AreaBar[] | Map<string, AreaBar[]>,
  dates: string[],
  beta: number,
  areas?: (date: string) => AreaWindow[],
): SigmaCurve {
  const stockDays = stock instanceof Map ? stock : byDate(stock);
  const spyDays = spy instanceof Map ? spy : byDate(spy);
  const sums = Object.fromEntries(
    sessions.map((s) => [
      s,
      {
        sq: new Float64Array(sessionEnd[s] - sessionBase[s]),
        n: new Uint8Array(sessionEnd[s] - sessionBase[s]),
      },
    ]),
  ) as Record<Session, { sq: Float64Array; n: Uint8Array }>;
  for (const date of dates.slice(-areaSigmaSessions)) {
    const windows =
      areas?.(date) ??
      dayAreas(stockDays.get(date) ?? [], spyDays.get(date) ?? [], date);
    for (const w of windows) {
      const into = sums[w.session];
      for (let k = 0; k < w.S.length; k++) {
        const a = w.S[k]! - beta * w.M[k]!;
        if (!Number.isFinite(a)) continue;
        const index = w.start + k - sessionBase[w.session];
        into.sq[index]! += a * a;
        into.n[index]!++;
      }
    }
  }
  const curve = (s: Session) =>
    Array.from(sums[s].sq, (sq, index) => {
      const n = sums[s].n[index]!;
      const sigma = n >= areaSigmaMinimum ? Math.sqrt(sq / n) : 0;
      return sigma > 0 ? Number(sigma.toPrecision(4)) : null;
    });
  return { pre: curve("pre"), regular: curve("regular"), post: curve("post") };
}

/** σ at a New York start minute; null outside the curve or without one. */
export function sigmaAt(
  curve: SigmaCurve | null | undefined,
  session: Session,
  minute: number,
): number | null {
  return curve?.[session]?.[minute - sessionBase[session]] ?? null;
}

export interface AreaInputs {
  ticker: string;
  stock: AreaBar[]; // at least the scored date's bars; others are ignored
  spy: AreaBar[];
  date: string;
  beta: number;
  sigma: SigmaCurve | null; // for this ticker and date
}

export interface AreaValue {
  gap: number | null; // s − β·m at T, % points
  area: number | null; // A at T, % points
  sigma: number | null;
  score: number | null; // 0–100; null without σ, SPY data, for SPY, or ≤ 5 minutes
}

const empty: AreaValue = { gap: null, area: null, sigma: null, score: null };

function valueAt(
  w: AreaWindow,
  minute: number,
  beta: number,
  curve: SigmaCurve | null,
): AreaValue {
  const k = minute - w.start;
  if (k < 0 || k >= w.S.length) return empty;
  const area = finite(w.S[k]! - beta * w.M[k]!);
  const sigma = sigmaAt(curve, w.session, minute);
  return {
    gap: finite(w.s[k]! - beta * w.m[k]!),
    area,
    sigma,
    score: k + 1 > areaMinimumMinutes ? areaScore(area, sigma) : null,
  };
}

/** SPY is never scored against itself. */
export const areaBenchmark = "SPY";

/**
 * Area, σ and score ending at New York start minute `minute` of `date` (the
 * alert bar, or the latest bar), from bars starting at or before it.
 */
export function areaAt(inputs: AreaInputs, minute: number): AreaValue {
  if (inputs.ticker === areaBenchmark) return empty;
  const session = sessionOf(inputs.date, minute);
  const w = dayAreas(inputs.stock, inputs.spy, inputs.date, minute).find(
    (x) => x.session === session,
  );
  return w ? valueAt(w, minute, inputs.beta, inputs.sigma) : empty;
}

/** Per-bar series for a day chart; see AreaVsSpySeries in the contracts. */
export interface AreaSeries {
  gap: (number | null)[];
  area: (number | null)[];
  sigma: (number | null)[];
  score: (number | null)[];
  windows: { session: Session; start: number }[]; // start: Unix s of t0
}

/**
 * Gap, area, σ and score at each bar of `align` (the ticker's bars of
 * `inputs.date`, in order), each ending at that bar's minute.
 */
export function areaSeries(inputs: AreaInputs, align: AreaBar[]): AreaSeries {
  const n = align.length;
  const nulls = () => new Array<number | null>(n).fill(null);
  const result: AreaSeries = {
    gap: nulls(),
    area: nulls(),
    sigma: nulls(),
    score: nulls(),
    windows: [],
  };
  if (inputs.ticker === areaBenchmark) return result;
  const windows = dayAreas(inputs.stock, inputs.spy, inputs.date);
  result.windows = windows.map((w) => ({
    session: w.session,
    start: newYorkToUtc(inputs.date, w.start) / 1000,
  }));
  align.forEach((bar, index) => {
    if (bar.date !== inputs.date) return;
    const w = windows.find((x) => x.session === bar.session);
    if (!w) return;
    const v = valueAt(w, bar.minute, inputs.beta, inputs.sigma);
    result.gap[index] = v.gap;
    result.area[index] = v.area;
    result.sigma[index] = v.sigma;
    result.score[index] = v.score;
  });
  return result;
}
