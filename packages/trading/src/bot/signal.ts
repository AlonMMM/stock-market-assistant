// The bot's entry signal (docs/tasks/backend-indi-bot.md): the "C" condition of
// the Indi backtest, ported line for line from `Day.tiers` in
// scripts/research/indi_bt/signals.py (branch research/indi-backtest).
//
//   1. steady strength vs SPY × beta: the t-stat of the 1-minute moves of the
//      stock minus beta × SPY, in the bet direction, is at least 2;
//   2. volume since the open is at least 1.5× the median of the same window
//      over the prior 20 sessions.
//
// Minutes are session minutes (09:30 New York = 0). Missing minutes carry the
// last close forward and count no volume, as the backtest did.

export interface MinuteBar {
  m: number; // session minute, 0–389
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** One prior session of the stock and of SPY. */
export interface PriorDay {
  stock: readonly MinuteBar[];
  spy: readonly MinuteBar[];
}

export interface SignalParams {
  firstMinute: number; // conditions are checked from here (09:40)
  lastMinute: number; // last minute a signal may come (15:44)
  minSteps: number;
  strengthT: number;
  rvolDay: number;
}

export const defaultSignalParams: SignalParams = {
  firstMinute: 10,
  lastMinute: 374,
  minSteps: 10,
  strengthT: 2,
  rvolDay: 1.5,
};

export interface Prior {
  beta: number | null;
  // Cumulative volume by minute of each prior session that traded at all.
  curves: number[][];
}

export interface Signal {
  minute: number;
  right: "C" | "P";
  t: number;
  rvol: number;
}

const SESSION = 390;

/** Closes for minutes 0–389, the last close carried over missing minutes. */
export function closes(bars: readonly MinuteBar[]): (number | null)[] {
  const by = new Map(bars.map((b) => [b.m, b]));
  const out: (number | null)[] = [];
  let last: number | null = null;
  for (let m = 0; m < SESSION; m++) {
    const b = by.get(m);
    if (b) last = b.c;
    out.push(last);
  }
  return out;
}

/** Volume traded from the open through each minute. */
export function cumulativeVolume(bars: readonly MinuteBar[]): number[] {
  const v = new Array<number>(SESSION).fill(0);
  for (const b of bars) if (b.m >= 0 && b.m < SESSION) v[b.m] = b.v;
  let sum = 0;
  return v.map((x) => (sum += x));
}

/** Beta to SPY from 5-minute returns over the prior sessions (needs > 300 pairs). */
export function betaFrom(days: readonly PriorDay[]): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const d of days) {
    const sc = closes(d.stock);
    const ss = closes(d.spy);
    for (let m = 5; m < SESSION; m += 5) {
      const a = sc[m],
        a0 = sc[m - 5],
        b = ss[m],
        b0 = ss[m - 5];
      if (a && a0 && b && b0) {
        ys.push(a / a0 - 1);
        xs.push(b / b0 - 1);
      }
    }
  }
  if (xs.length <= 300) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i]! - mx) * (ys[i]! - my);
    varX += (xs[i]! - mx) ** 2;
  }
  return varX ? cov / varX : null;
}

/** What the signal needs from the 20 sessions before today. */
export function priorFrom(days: readonly PriorDay[]): Prior {
  return {
    beta: betaFrom(days),
    curves: days
      .map((d) => cumulativeVolume(d.stock))
      .filter((c) => c[SESSION - 1]! > 0),
  };
}

/**
 * The first minute up to `upTo` where the C condition holds, in the direction
 * that reaches it first, or null. Called again each minute with more bars, it
 * keeps answering the same first minute.
 */
export function cSignal(
  day: readonly MinuteBar[],
  spy: readonly MinuteBar[],
  prior: Prior,
  upTo: number = defaultSignalParams.lastMinute,
  p: SignalParams = defaultSignalParams,
): Signal | null {
  if (prior.curves.length < 10 || prior.beta === null) return null;
  const beta = prior.beta;
  const c = closes(day);
  const s = closes(spy);
  const cum = cumulativeVolume(day);
  const last = Math.min(upTo, p.lastMinute);
  // Steps of the call side; the put side's are the same numbers negated, so its
  // t-stat is this one negated and the two sides never hold at once.
  const steps: number[] = [];
  for (let m = 1; m <= last; m++) {
    const cm = c[m],
      c0 = c[m - 1],
      sm = s[m],
      s0 = s[m - 1];
    if (cm && c0 && sm && s0) steps.push(cm / c0 - 1 - beta * (sm / s0 - 1));
    if (m < p.firstMinute || steps.length < p.minSteps || c[m] === null)
      continue;
    const sd = pstdev(steps);
    const t = sd ? (mean(steps) / sd) * Math.sqrt(steps.length) : 0;
    const usual = median(prior.curves.map((curve) => curve[m]!));
    const rvol = usual ? cum[m]! / usual : 0;
    if (rvol < p.rvolDay) continue;
    if (t >= p.strengthT) return { minute: m, right: "C", t, rvol };
    if (-t >= p.strengthT) return { minute: m, right: "P", t: -t, rvol };
  }
  return null;
}

function mean(xs: readonly number[]): number {
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

// Population standard deviation, as Python's statistics.pstdev.
function pstdev(xs: readonly number[]): number {
  const mu = mean(xs);
  let sum = 0;
  for (const x of xs) sum += (x - mu) ** 2;
  return Math.sqrt(sum / xs.length);
}

// Python's statistics.median: the middle two averaged for an even count.
function median(xs: readonly number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}
