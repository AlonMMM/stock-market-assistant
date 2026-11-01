// The bot's entry signal (docs/tasks/backend-indi-bot.md): the "C" condition of
// the Indi backtest, ported line for line from `Day.tiers` in
// scripts/research/indi_bt/signals.py (branch research/indi-backtest).
//
//   1. steady strength vs SPY × beta: the t-stat of the 1-minute moves of the
//      stock minus beta × SPY, in the bet direction, is at least 1.8 (the V2
//      research's threshold; the V1 backtest used 2; `minT` in settings.ts);
//   2. volume since the open is at least 1.5× the median of the same window
//      over the prior 20 sessions.
//
// The D2 bonus (version 2.5, the 2026-10-25 champion, rule c12_15 of
// defence_signals.py on branch research/indi-v2): with the volume as above,
// a lower strength (t 1.2) also enters when the stock held up on the market's
// bad minutes. D2 is the stock's move minus beta × SPY summed over the minutes
// of the last 30 where SPY moved against the bet, in the stock's unit (a
// typical 30-minute move, levels.ts); the bonus needs D2 ≥ 1.5.
//
// Minutes are session minutes (09:30 New York = 0). Missing minutes carry the
// last close forward and count no volume, as the backtest did.

import { priorLevels } from "./levels.js";

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
  bonusT: number | null; // the D2 bonus's lower t; null = no bonus
  bonusD2: number;
  d2Window: number; // minutes
}

export const defaultSignalParams: SignalParams = {
  firstMinute: 10,
  lastMinute: 374,
  minSteps: 10,
  strengthT: 1.8,
  rvolDay: 1.5,
  bonusT: null,
  bonusD2: 1.5,
  d2Window: 30,
};

export interface Prior {
  beta: number | null;
  // Cumulative volume by minute of each prior session that traded at all.
  curves: number[][];
  // A typical 30-minute move as a fraction of the price, from the 5 sessions
  // before today (levels.ts); null when they are short. D2 needs it.
  unit: number | null;
  // The last prior session's close, to find a split at today's open.
  lastClose?: number | null;
}

// The bars are not adjusted for splits (they price the strikes), so a 10:1
// split made the volume baseline ~10× too low for 20 sessions and the volume
// rule passed on any day (the audit of 2026-10-31, B6; research store.py
// split_ratio). A split is read from the raw prices: yesterday's close /
// today's open within 4% of N (an N:1 split) or of 1 / N (a 1:N reverse one).
const splitSizes = [2, 3, 4, 5, 8, 10, 15, 20, 25, 30, 40, 50];

/** The split between a close and the next session's open: N, 1 / N, or 1 (none). */
export function splitRatio(prevClose: number, open: number): number {
  if (!(prevClose > 0 && open > 0)) return 1;
  const r = prevClose / open;
  for (const n of splitSizes) {
    if (Math.abs(r / n - 1) < 0.04) return n;
    if (Math.abs(r * n - 1) < 0.04) return 1 / n;
  }
  return 1;
}

/** Today's split against the prior sessions, from today's first bar (1 when none). */
function todaySplit(prior: Prior, day: readonly MinuteBar[]): number {
  const first = day[0];
  if (!first || !prior.lastClose) return 1;
  return splitRatio(prior.lastClose, first.o);
}

export interface Signal {
  minute: number;
  right: "C" | "P";
  t: number;
  rvol: number;
  d2: number | null; // D2 at the signal minute, in the signal's direction
  bonus: boolean; // entered on the D2 bonus, t under strengthT
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
  // Each session's volume in the last session's shares: times every split after it.
  const factor = days.map(() => 1);
  for (let i = days.length - 2; i >= 0; i--) {
    const close = days[i]!.stock.at(-1)?.c ?? 0;
    const open = days[i + 1]!.stock[0]?.o ?? 0;
    factor[i] = factor[i + 1]! * splitRatio(close, open);
  }
  return {
    beta: betaFrom(days),
    curves: days
      .map((d, i) => cumulativeVolume(d.stock).map((v) => v * factor[i]!))
      .filter((c) => c[SESSION - 1]! > 0),
    unit: priorLevels(days.slice(-5).map((d) => d.stock))?.unit ?? null,
    lastClose: days.at(-1)?.stock.at(-1)?.c ?? null,
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
  // The last bar (minute upTo) is the forming minute (early entry): its volume
  // is not in yet, so its volume ratio is today's volume through the minute
  // before over the usual through the minute before, as the backtest's close
  // of that minute reads it (2.10's tiers, the release review of 2026-11-01).
  forming = false,
): Signal | null {
  if (prior.curves.length < 10 || prior.beta === null) return null;
  const beta = prior.beta;
  const c = closes(day);
  const s = closes(spy);
  const cum = cumulativeVolume(day);
  const split = todaySplit(prior, day);
  const last = Math.min(upTo, p.lastMinute);
  const unit = prior.unit;
  const bonusT = unit ? p.bonusT : null;
  // Steps of the call side; the put side's are the same numbers negated, so its
  // t-stat is this one negated and the two sides never hold at once.
  const steps: number[] = [];
  // Each minute's part of D2 for a call (SPY down) and a put (SPY up), in units.
  const d2Call = new Array<number>(SESSION).fill(0);
  const d2Put = new Array<number>(SESSION).fill(0);
  let sumCall = 0;
  let sumPut = 0;
  for (let m = 1; m <= last; m++) {
    const cm = c[m],
      c0 = c[m - 1],
      sm = s[m],
      s0 = s[m - 1];
    if (cm && c0 && sm && s0) {
      const spyMove = sm / s0 - 1;
      const x = cm / c0 - 1 - beta * spyMove;
      steps.push(x);
      if (unit && spyMove < 0) d2Call[m] = x / unit;
      if (unit && spyMove > 0) d2Put[m] = -x / unit;
    }
    sumCall += d2Call[m]!;
    sumPut += d2Put[m]!;
    const gone = m - p.d2Window;
    if (gone >= 1) {
      sumCall -= d2Call[gone]!;
      sumPut -= d2Put[gone]!;
    }
    if (m < p.firstMinute || steps.length < p.minSteps || c[m] === null)
      continue;
    const sd = pstdev(steps);
    const t = sd ? (mean(steps) / sd) * Math.sqrt(steps.length) : 0;
    let at = m;
    if (forming && m === upTo && m > 0) at = m - 1;
    const usual = median(prior.curves.map((curve) => curve[at]!)) * split;
    const rvol = usual ? cum[m]! / usual : 0;
    if (rvol < p.rvolDay) continue;
    const d2 = unit ? sumCall : null;
    if (passes(t, sumCall, p.strengthT, bonusT, p.bonusD2))
      return { minute: m, right: "C", t, rvol, d2, bonus: t < p.strengthT };
    const d2p = unit ? sumPut : null;
    if (passes(-t, sumPut, p.strengthT, bonusT, p.bonusD2))
      return {
        minute: m,
        right: "P",
        t: -t,
        rvol,
        d2: d2p,
        bonus: -t < p.strengthT,
      };
  }
  return null;
}

/** The strength alone, or the lower strength with the defended drop (D2). */
function passes(
  t: number,
  d2: number,
  strengthT: number,
  bonusT: number | null,
  bonusD2: number,
): boolean {
  if (t >= strengthT) return true;
  return bonusT !== null && t >= bonusT && d2 >= bonusD2;
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

/**
 * Where a stock stands at minute `m` (for the live scan): signed t-stat,
 * volume ratio, and D2 on the t-stat's side over the last `d2Window`
 * minutes (null without the stock's typical move), as cSignal counts it.
 */
export function cState(
  day: readonly MinuteBar[],
  spy: readonly MinuteBar[],
  prior: Prior,
  m: number,
  d2Window: number = defaultSignalParams.d2Window,
): { t: number; rvol: number; d2: number | null } | null {
  if (prior.curves.length < 10 || prior.beta === null || m < 1) return null;
  const c = closes(day);
  const s = closes(spy);
  const steps: number[] = [];
  const last = Math.min(m, SESSION - 1);
  let d2Call = 0;
  let d2Put = 0;
  for (let k = 1; k <= last; k++) {
    const ck = c[k],
      c0 = c[k - 1],
      sk = s[k],
      s0 = s[k - 1];
    if (!(ck && c0 && sk && s0)) continue;
    const spyMove = sk / s0 - 1;
    const x = ck / c0 - 1 - prior.beta * spyMove;
    steps.push(x);
    if (k <= last - d2Window) continue;
    if (spyMove < 0) d2Call += x;
    if (spyMove > 0) d2Put -= x;
  }
  if (steps.length < 2) return null;
  const sd = pstdev(steps);
  const t = sd ? (mean(steps) / sd) * Math.sqrt(steps.length) : 0;
  const unit = prior.unit;
  let d2: number | null = null;
  if (unit) d2 = (t < 0 ? d2Put : d2Call) / unit;
  const usual =
    median(prior.curves.map((curve) => curve[Math.min(m, SESSION - 1)]!)) *
    todaySplit(prior, day);
  const cum = cumulativeVolume(day)[Math.min(m, SESSION - 1)]!;
  return { t, rvol: usual ? cum / usual : 0, d2 };
}
