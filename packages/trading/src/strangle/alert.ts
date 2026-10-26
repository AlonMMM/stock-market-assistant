// The site's volume alert (rvol-v6, packages/alerts/src/relative-volume.ts)
// as the strangle's backtest evaluated it (`rvol_alert.py` in
// scripts/research/indi_bt, branch research/indi-v2): on regular-session
// 1-minute bars, per minute, "up" / "down" when the alert's condition holds,
// else null. No cooldown and no fresh-crossing: the strategy takes the first
// minute of the day the condition holds. Ported line for line for parity.

import type { MinuteBar } from "../bot/signal.js";

export const alertRule = {
  window: 3,
  threshold: 4,
  pace: 4,
  minVolume: 10000,
  priceMultiple: 3,
  minMovePercent: 0.5,
  paceSkipOpen: 30,
  paceSkipClose: 30,
  paceMinMinutes: 15,
  minSamples: 10,
};

export type AlertSide = "up" | "down";
/** Per minute 0–389: [window volume, |move| %] or null. */
export type Windows = ([number, number] | null)[];

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const k = Math.floor(v.length / 2);
  return v.length % 2 ? v[k]! : (v[k - 1]! + v[k]!) / 2;
}

/** The 3-minute windows of one session: volume and |move| against the close before. */
export function windows(bars: readonly MinuteBar[]): Windows {
  const W = alertRule.window;
  const by = new Map(bars.map((b) => [b.m, b]));
  const out: Windows = new Array(390).fill(null);
  for (let m = W; m < 390; m++) {
    let ok = true;
    for (let k = m - W; k <= m; k++) if (!by.has(k)) ok = false;
    if (!ok) continue;
    let vol = 0;
    for (let k = m - W + 1; k <= m; k++) vol += by.get(k)!.v;
    const move = Math.abs(by.get(m)!.c / by.get(m - W)!.c - 1) * 100;
    out[m] = [vol, move];
  }
  return out;
}

/**
 * The alert's side at each minute of a day, from today's bars and the prior
 * sessions' windows (oldest first; up to 20).
 */
export function alerts(
  bars: readonly MinuteBar[],
  hist: readonly Windows[],
): (AlertSide | null)[] {
  const r = alertRule;
  const W = r.window;
  const w = windows(bars);
  const by = new Map(bars.map((b) => [b.m, b]));
  const out: (AlertSide | null)[] = new Array(390).fill(null);
  const pace = (m: number) => r.paceSkipOpen <= m && m <= 389 - r.paceSkipClose;
  let paceVol = 0;
  let paceN = 0;
  for (let m = 0; m < 390; m++) {
    const b = by.get(m);
    const k = m - W;
    if (k >= 0 && pace(k) && by.has(k)) {
      paceVol += by.get(k)!.v;
      paceN++;
    }
    const cur = w[m];
    if (!cur || !b) continue;
    const [actual, move] = cur;
    const samples = hist
      .map((h) => h[m])
      .filter((x): x is [number, number] => !!x);
    if (samples.length < r.minSamples) continue;
    const expected = median(samples.map((s) => s[0]));
    const expectedMove = median(samples.map((s) => s[1]));
    const ratio = expected > 0 ? actual / expected : null;
    let inPace = true;
    for (let q = m - W + 1; q <= m; q++) if (!pace(q)) inPace = false;
    const paceRatio =
      inPace && paceN >= r.paceMinMinutes && paceVol > 0
        ? actual / ((paceVol / paceN) * W)
        : null;
    const volumeOk =
      (ratio !== null && ratio >= r.threshold) ||
      (paceRatio !== null && paceRatio >= r.pace);
    const moveOk =
      move >= r.priceMultiple * expectedMove && move >= r.minMovePercent;
    if (!(volumeOk && moveOk && actual >= r.minVolume)) continue;
    const prev = by.get(m - 1)!.c;
    if (b.c > prev && b.c > b.o) out[m] = "up";
    else if (b.c < prev && b.c < b.o) out[m] = "down";
  }
  return out;
}

/** The first minute from `from` through `to` with an alert, and its side, or null. */
export function firstAlert(
  sides: readonly (AlertSide | null)[],
  from: number,
  to: number,
): { minute: number; side: AlertSide } | null {
  for (let m = from; m <= to && m < sides.length; m++) {
    const s = sides[m];
    if (s) return { minute: m, side: s };
  }
  return null;
}

/** One stock's alert checks at a minute, for the app's map (StrangleView.scan). */
export interface AlertMeasure {
  minute: number;
  // The volume check: the better of its two ratios (the window's volume vs
  // the median of the same window in prior sessions, and vs today's pace),
  // in the units of `alertRule.threshold`: the check holds exactly when
  // volRatio >= threshold (both ratios need 4×).
  volRatio: number;
  // The window's |move| vs the median |move| of the same window in prior
  // sessions; the move check needs priceMultiple.
  moveRatio: number;
  shares: number; // the window's volume; the alert needs minVolume
  movePct: number; // the window's |move| %; the alert needs minMovePercent
  // The window's direction: its close vs the close before it.
  side: AlertSide;
}

// JSON has no Infinity: a ratio over a zero median shows at this cap.
const ratioCap = 99;

/**
 * The quantities `alerts` checks at minute `m`, computed for `m` alone (the
 * pace from today's minutes up to m − window, as `alerts` accumulates it).
 * Null where the alert cannot be evaluated (a missing bar, too little
 * history).
 */
export function measureAt(
  bars: readonly MinuteBar[],
  hist: readonly Windows[],
  m: number,
): AlertMeasure | null {
  const r = alertRule;
  const W = r.window;
  if (m < W || m >= 390) return null;
  const by = new Map(bars.map((b) => [b.m, b]));
  for (let k = m - W; k <= m; k++) if (!by.has(k)) return null;
  let actual = 0;
  for (let k = m - W + 1; k <= m; k++) actual += by.get(k)!.v;
  const last = by.get(m)!.c;
  const before = by.get(m - W)!.c;
  const move = Math.abs(last / before - 1) * 100;
  const samples = hist
    .map((h) => h[m])
    .filter((x): x is [number, number] => !!x);
  if (samples.length < r.minSamples) return null;
  const expected = median(samples.map((s) => s[0]));
  const expectedMove = median(samples.map((s) => s[1]));
  const pace = (q: number) => r.paceSkipOpen <= q && q <= 389 - r.paceSkipClose;
  let paceVol = 0;
  let paceN = 0;
  for (let k = 0; k <= m - W; k++)
    if (pace(k) && by.has(k)) {
      paceVol += by.get(k)!.v;
      paceN++;
    }
  let inPace = true;
  for (let q = m - W + 1; q <= m; q++) if (!pace(q)) inPace = false;
  // In units of the threshold, so the pace ratio (its own 4×) compares.
  let volume = 0;
  if (expected > 0) volume = actual / expected / r.threshold;
  if (inPace && paceN >= r.paceMinMinutes && paceVol > 0)
    volume = Math.max(volume, actual / ((paceVol / paceN) * W) / r.pace);
  let moveRatio = 0;
  if (expectedMove > 0) moveRatio = move / expectedMove;
  else if (move > 0) moveRatio = ratioCap;
  return {
    minute: m,
    volRatio: Math.min(ratioCap, volume * r.threshold),
    moveRatio: Math.min(ratioCap, moveRatio),
    shares: actual,
    movePct: move,
    side: last >= before ? "up" : "down",
  };
}

/** How close a stock is to an alert: 1 once both ratio checks are met. */
export const alertCloseness = (x: { volRatio: number; moveRatio: number }) =>
  Math.min(
    x.volRatio / alertRule.threshold,
    x.moveRatio / alertRule.priceMultiple,
  );
