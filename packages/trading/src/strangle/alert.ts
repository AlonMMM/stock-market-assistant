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
