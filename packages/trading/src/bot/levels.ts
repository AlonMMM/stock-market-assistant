// The failed-break sale (docs/tasks/backend-bot-failed-break.md), ported from
// `levels.py` and `fail_rebuy.py` in scripts/research/indi_bt (branch
// research/indi-v2): on the entry day, when the stock reaches the next level
// ahead of the entry and falls back from it without breaking it, sell all.
//
// Levels, known at the minute they are used: yesterday's high and low, the
// high and low of the 5 sessions before today, the first 15 minutes' high and
// low (from 09:45), and the day's high and low so far (before this minute).
// Distances are in the stock's own unit: the spread of its 1-minute returns
// over the 5 sessions before today × √30, a typical 30-minute move.
//
// Watching, minute by minute on the stock's closes from the minute after the
// signal: a close 0.25 units beyond the level is a break (the watch ends); a
// close within 0.25 units of it is a touch; after a touch, a close 0.5 units
// back from it within 30 minutes is a failed break; 30 minutes after the touch
// with neither, the watch ends.

import type { MinuteBar } from "./signal.js";

export const levelRules = { near: 0.25, beyond: 0.25, back: 0.5, wait: 30 };

/** What the 5 sessions before today give: their levels and the stock's unit. */
export interface PriorLevels {
  prevHigh: number;
  prevLow: number;
  fiveHigh: number;
  fiveLow: number;
  unit: number; // a typical 30-minute move, as a fraction of the price
}

/**
 * From the 5 sessions before today, oldest first. Null when a session has no
 * bars or there are fewer than 500 one-minute returns, as in the backtest.
 */
export function priorLevels(
  sessions: readonly (readonly MinuteBar[])[],
): PriorLevels | null {
  if (sessions.length < 5) return null;
  const five = sessions.slice(-5);
  if (five.some((s) => s.length === 0)) return null;
  const rets: number[] = [];
  for (const s of five)
    for (let j = 1; j < s.length; j++)
      if (s[j - 1]!.c > 0 && s[j]!.c > 0)
        rets.push(Math.log(s[j]!.c / s[j - 1]!.c));
  if (rets.length < 500) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(
    rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length,
  );
  const last = five.at(-1)!;
  const high = (s: readonly MinuteBar[]) => Math.max(...s.map((b) => b.h));
  const low = (s: readonly MinuteBar[]) => Math.min(...s.map((b) => b.l));
  return {
    prevHigh: high(last),
    prevLow: low(last),
    fiveHigh: Math.max(...five.map(high)),
    fiveLow: Math.min(...five.map(low)),
    unit: sd * Math.sqrt(30),
  };
}

export interface Level {
  name: string;
  price: number;
}

/** The levels known at session minute `m` (the backtest's order). */
export function levelsAt(
  prior: PriorLevels,
  today: readonly MinuteBar[],
  m: number,
): Level[] {
  const out: Level[] = [
    { name: "yesterday's high", price: prior.prevHigh },
    { name: "yesterday's low", price: prior.prevLow },
    { name: "the 5-day high", price: prior.fiveHigh },
    { name: "the 5-day low", price: prior.fiveLow },
  ];
  const before = today.filter((b) => b.m < m);
  if (before.length) {
    out.push(
      { name: "the day's high", price: Math.max(...before.map((b) => b.h)) },
      { name: "the day's low", price: Math.min(...before.map((b) => b.l)) },
    );
  }
  const first = today.filter((b) => b.m < 15);
  if (m >= 15 && first.length) {
    out.push(
      {
        name: "the 15-minute high",
        price: Math.max(...first.map((b) => b.h)),
      },
      { name: "the 15-minute low", price: Math.min(...first.map((b) => b.l)) },
    );
  }
  return out;
}

/** What the bot watches after an entry, kept with the position. */
export interface BreakWatch {
  name: string;
  level: number;
  unit: number; // the unit in dollars at the entry price
  touch: number | null; // first minute within `near` of the level
  state: "watching" | "broken" | "ended" | "failed";
  at: number | null; // minute the watch ended or failed
  through: number; // last session minute looked at
}

/**
 * The nearest level ahead of `price` in the bet's direction at minute `m`
 * (above for a call, below for a put), as a new watch; null when there is no
 * level ahead or no unit.
 */
export function watchFor(
  prior: PriorLevels | null | undefined,
  today: readonly MinuteBar[],
  m: number,
  price: number,
  right: "C" | "P",
): BreakWatch | null {
  if (!prior || !(prior.unit > 0) || !(price > 0)) return null;
  const bet = right === "C" ? 1 : -1;
  let best: { level: Level; d: number } | null = null;
  for (const level of levelsAt(prior, today, m)) {
    const d = (bet * (level.price - price)) / (prior.unit * price);
    if (d > 0 && (best === null || d < best.d)) best = { level, d };
  }
  if (!best) return null;
  return {
    name: best.level.name,
    level: best.level.price,
    unit: prior.unit * price,
    touch: null,
    state: "watching",
    at: null,
    through: m,
  };
}

/**
 * The watch after the stock's closes through minute `to` (bars after
 * `w.through`; a minute without a bar is skipped, as in the backtest).
 */
export function advanceWatch(
  w: BreakWatch,
  today: readonly MinuteBar[],
  to: number,
  right: "C" | "P",
  r = levelRules,
): BreakWatch {
  if (w.state !== "watching" || to <= w.through) return w;
  const bet = right === "C" ? 1 : -1;
  let next = { ...w };
  for (const b of today) {
    if (b.m <= w.through || b.m > to) continue;
    const d = (bet * (w.level - b.c)) / w.unit; // > 0: still short of the level
    if (d <= -r.beyond)
      return { ...next, state: "broken", at: b.m, through: to };
    if (d <= r.near && next.touch === null) next = { ...next, touch: b.m };
    if (next.touch !== null && b.m - next.touch > r.wait)
      return { ...next, state: "ended", at: b.m, through: to };
    if (next.touch !== null && d >= r.back)
      return { ...next, state: "failed", at: b.m, through: to };
  }
  return { ...next, through: to };
}
