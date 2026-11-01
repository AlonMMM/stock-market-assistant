// The 60-second volume alert, F60x2 (the user, 2026-10-29: "a new bot
// version"): the early-rules study's R60 rule at 2× (sma-fast-volume
// scripts/research/fast_volume.py `rule_signals`, early_rules.py `fire`) as
// the Volume bot's backtest ran it (indi_bt/f60_alerts.py): on 10-second
// bars, a rolling 60-second window checked every 10 s. Ported line for line.

export const fastRule = {
  slots: 2340, // 10-second slots in a regular session
  window: 6, // slots: 60 seconds
  volume: 2, // × the median of the same window in prior sessions, or × today's pace
  priceMultiple: 3, // |move| ≥ 3 × its median
  minMovePercent: 0.5 * Math.sqrt(6 / 18), // 0.29%
  minShares: (10000 * 6) / 18, // 3,333
  days: 20, // prior sessions in the medians
  cooldown: 180, // slots between alerts: 30 minutes
  firstSlot: 59, // the slot ending 09:40:00
  lastSlot: 1259, // the slot ending 13:00:00
  paceFrom: 180, // the pace zone: minutes 30..359 of the session, in slots
  paceTo: 2160,
};

export type FastRule = typeof fastRule;

// The shock alert (the user, 2026-10-30, "a new version to deploy"): the same
// rule at 15× volume, 09:40-15:30 (indi_bt/f60_alerts.py F60_K=15
// F60_LAST=2159, the backtest's e_shock15 alerts).
export const shockRule: FastRule = { ...fastRule, volume: 15, lastSlot: 2159 };

/** One session of a stock in 10-second slots: volume (0 without a bar) and close (null without a bar). */
export interface FastDay {
  v: number[];
  c: (number | null)[];
}

/** Per slot, the 60-second window's volume and |move| %, null where it does not fit. */
export interface FastWindows {
  vol: (number | null)[];
  move: (number | null)[];
}

/** The closes carried forward; slots before the first bar take the first close (fast_volume.ffill). */
export function carried(c: readonly (number | null)[]): (number | null)[] {
  const out: (number | null)[] = new Array(c.length).fill(null);
  let last: number | null = null;
  for (let t = 0; t < c.length; t++) {
    if (c[t] !== null && c[t] !== undefined) last = c[t]!;
    out[t] = last;
  }
  const first = out.findIndex((x) => x !== null);
  for (let t = 0; t < first; t++) out[t] = out[first]!;
  return out;
}

/** A session's windows, for the prior-session medians. */
export function fastWindows(day: FastDay): FastWindows {
  const W = fastRule.window;
  const n = fastRule.slots;
  const cf = carried(day.c);
  const vol: (number | null)[] = new Array(n).fill(null);
  const move: (number | null)[] = new Array(n).fill(null);
  let sum = 0;
  for (let t = 0; t < n; t++) {
    sum += day.v[t] ?? 0;
    if (t >= W) sum -= day.v[t - W] ?? 0;
    if (t >= W - 1) vol[t] = sum;
    const now = cf[t] ?? null;
    const before = t >= W ? (cf[t - W] ?? null) : null;
    if (now !== null && before !== null)
      move[t] = Math.abs((now / before - 1) * 100);
  }
  return { vol, move };
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const k = Math.floor(v.length / 2);
  return v.length % 2 ? v[k]! : (v[k - 1]! + v[k]!) / 2;
}

/** Per slot, the medians over the prior sessions; null when any session lacks the slot (np.median of a NaN). */
export interface FastBaseline {
  vol: (number | null)[];
  move: (number | null)[];
}

export function fastBaseline(
  prior: readonly FastWindows[],
): FastBaseline | null {
  if (prior.length < fastRule.days) return null;
  const days = prior.slice(-fastRule.days);
  const n = fastRule.slots;
  const pick = (key: keyof FastWindows) => {
    const out: (number | null)[] = new Array(n).fill(null);
    for (let t = 0; t < n; t++) {
      const xs: number[] = [];
      for (const d of days) {
        const x = d[key][t];
        if (x === null || x === undefined) break;
        xs.push(x);
      }
      if (xs.length === days.length) out[t] = median(xs);
    }
    return out;
  };
  return { vol: pick("vol"), move: pick("move") };
}

/** Whether the rule holds at slot t of today (fast_volume.rule_signals, kind "roll"). */
export function fastState(
  today: FastDay,
  cf: readonly (number | null)[],
  base: FastBaseline,
  t: number,
  paceCum: readonly number[], // today's zone volume summed through each slot
  r: FastRule = fastRule,
): { on: boolean; up: boolean } {
  const W = r.window;
  const off = { on: false, up: false };
  if (t < W) return off;
  let win = 0;
  for (let k = t - W + 1; k <= t; k++) win += today.v[k] ?? 0;
  const expected = base.vol[t];
  if (expected === null || expected === undefined) return off;
  const now = cf[t] ?? null;
  const anchor = cf[t - W] ?? null;
  const prev = cf[t - 1] ?? null;
  if (now === null || anchor === null) return off;
  const move = (now / anchor - 1) * 100;
  // A zero median: any volume is an infinite ratio (np.nan_to_num keeps +inf).
  let ratio = 0;
  if (expected > 0) ratio = win / expected;
  else if (win > 0) ratio = Infinity;
  let pace = 0;
  const before = t - W;
  if (before >= r.paceFrom + 15 * 6 - 1 && t < r.paceTo) {
    const avg = paceCum[before]! / (before - r.paceFrom + 1);
    if (avg > 0) pace = win / (avg * W);
  }
  const volumeOk = ratio >= r.volume || pace >= r.volume;
  const expMove = base.move[t];
  const am = Math.abs(move);
  const moveOk =
    expMove !== null &&
    expMove !== undefined &&
    am >= r.priceMultiple * expMove &&
    am >= r.minMovePercent;
  let dirOk = false;
  if (prev !== null) {
    const last = now - prev;
    dirOk = (move > 0 && last >= 0) || (move < 0 && last <= 0);
  }
  return {
    on: volumeOk && moveOk && dirOk && win >= r.minShares,
    up: move > 0,
  };
}

/** Today's zone volume summed through each slot (fast_volume.pace_ratio's cum). */
export function paceSums(v: readonly number[]): number[] {
  const out: number[] = new Array(fastRule.slots).fill(0);
  let sum = 0;
  for (let t = 0; t < fastRule.slots; t++) {
    if (t >= fastRule.paceFrom && t < fastRule.paceTo) sum += v[t] ?? 0;
    out[t] = sum;
  }
  return out;
}

/**
 * The alerts of a whole session (early_rules.fire): a fresh crossing into the
 * rule outside a 30-minute cooldown, counted from the open; kept from 09:40 to
 * the rule's last slot. For the parity check against the backtest's alert files.
 */
export function fastAlerts(
  today: FastDay,
  base: FastBaseline,
  rule: FastRule = fastRule,
): { slot: number; second: number; price: number; up: boolean }[] {
  const cf = carried(today.c);
  const cum = paceSums(today.v);
  const out: { slot: number; second: number; price: number; up: boolean }[] =
    [];
  const fire = new FastFire();
  for (let t = 0; t < fastRule.slots; t++) {
    const st = fastState(today, cf, base, t, cum, rule);
    if (!fire.step(t, st.on)) continue;
    if (t < rule.firstSlot || t > rule.lastSlot) continue;
    out.push({ slot: t, second: (t + 1) * 10, price: cf[t]!, up: st.up });
  }
  return out;
}

/** The fresh-crossing and cooldown state of one stock's day, slot by slot in order. */
export class FastFire {
  private above = false;
  private last = -1e9;
  step(t: number, on: boolean): boolean {
    const fired = on && !this.above && t - this.last >= fastRule.cooldown;
    if (fired) this.last = t;
    this.above = on;
    return fired;
  }
}
