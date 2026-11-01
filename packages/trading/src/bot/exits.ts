import { breakEvenStock, tighterLevel } from "./lock.js";

// The bot's exit rules (docs/tasks/backend-indi-bot.md), ported from `walk` in
// scripts/research/indi_bt/sim.py with the backtest's winning exit: "your
// stop" plus the overnight hold.
//
// Entry day:
//   - 10 minutes after the entry, if the stock is against the entry price, sell half;
//   - 20 minutes after, if it is still against, sell the rest;
//   - the option at -30% while the stock is against: sell all; once the
//     10-minute check sold half, the rest at `restStopOut` (-20% since
//     version 2.4) instead;
//   - the signal's own t-stat vs SPY × beta (cumulative from the open) down to
//     `strengthOut` or under: sell all (the 2026-10-24 champion, exits.ts T);
//   - the staged stock exit (`stages`, version 2.8, sim.py stock_stages): half
//     once the stock is `half` of its usual 30-minute move (S30) against the
//     price at the signal, all at `full` against;
//   - the break-even lock (`lock`, version 2.9, sim.py be_lock): once the
//     option is `arm` over its cost, the stock price where the option would be
//     worth its cost (lock.ts) is a stop on the stock, worked out again each
//     minute it is still `arm` up (the tighter kept); all out when the stock
//     gets there.
// 15:50: hold overnight what is up >= carryMinGain (+50% since version 2.3,
//   +100% before; a next session before expiry, at
//   most 2 nights); sell the rest. What is held is worth at most `nightCapPct`
//   of the account (`nightCapSell`, 10% by default): the excess is sold first.
// A carried day: nothing before 09:40. On the first carried day at 09:40, a gap
//   of >= 0.5% our way sells half, otherwise all. The option at -30% sells all.
//   Expiry day: all out at 15:30.
//
// Also on the entry day, outside these rules: the failed-break sale (levels.ts).
//
// The bot only ever sells contracts it bought and still holds: every quantity
// here is a share of `position.qty`.

export interface ExitRules {
  checks: readonly (readonly [minutes: number, share: number])[];
  stopOut: number; // option return that sells all (with the stock against on the entry day)
  // The same for what is left once the 10-minute check sold half (entry day
  // only); null is off, the rest keeps `stopOut`.
  restStopOut: number | null;
  // The signal's t-stat, in the bet's direction, at or under which the entry
  // day sells all; null is off. The entry needed 1.8.
  strengthOut: number | null;
  // The staged stock exit, in S30 against the signal price; null is off.
  stages: { half: number; full: number } | null;
  // An entry at this session minute or later is not sold on its entry day
  // while above its cost (the 15:50 decision still runs); null is off.
  lateHoldFrom: number | null;
  // The break-even lock: armed at this option return (0.5 = +50%); null is off.
  lock: { arm: number } | null;
  eodMinute: number; // 15:50
  carryMinGain: number; // hold overnight from this option return
  carryMaxNights: number;
  morningMinute: number; // 09:40
  gapKeep: number; // % gap our way that keeps half
  expiryLastMinute: number; // 15:30
}

export const defaultExitRules: ExitRules = {
  checks: [
    [10, 0.5],
    [20, 1],
  ],
  stopOut: -0.3,
  restStopOut: null,
  strengthOut: null,
  stages: null,
  lateHoldFrom: null,
  lock: null,
  eodMinute: 380,
  carryMinGain: 1,
  carryMaxNights: 2,
  morningMinute: 10,
  gapKeep: 0.5,
  expiryLastMinute: 360,
};

export interface BotPositionState {
  right: "C" | "P";
  qty: number; // contracts the bot holds
  cost: number; // average price paid per contract
  entryMinute: number; // session minute of the signal
  entryStock: number; // the stock's close at the signal minute
  nights: number; // sessions carried so far (0 on the entry day)
  checksDone: number[]; // indexes of `checks` already looked at
  morningDone: boolean;
  // The 10-minute check sold part of it (the caller reads its sales).
  halfSold?: boolean;
  // The staged exit's half was sold (the caller reads its sales).
  stageHalfSold?: boolean;
  // The break-even lock's stock level once armed (stored with the position, so
  // a restart keeps it); null / missing before.
  lockLevel?: number | null;
}

export interface ExitMarket {
  minute: number; // session minute now
  stock: number | null; // the stock's last close
  option: number | null; // the option's mark (mid)
  // The signal's t-stat now on the call side (a put's is the negation), from
  // the closed minutes; null when it cannot be computed.
  strength?: number | null;
  // The stock's usual 30-minute move as a fraction of its price (levels.ts
  // priorLevels unit), for the staged exit; null when unknown.
  unit?: number | null;
  // The stock's last closed minute, for the break-even lock (the research
  // decides on minute closes; one live print through the level must not sell);
  // missing / null: `stock`.
  close?: number | null;
  // The contract's strike and years to its expiry (16:00 New York), for the
  // break-even lock; null when unknown.
  strike?: number | null;
  years?: number | null;
  isExpiryDay: boolean;
  // A session after today on or before the expiry date (a carry is possible).
  sessionBeforeExpiry: boolean;
  // Today's open and the previous close, for the morning gap.
  open: number | null;
  prevClose: number | null;
}

export type ExitReason =
  | "check-10"
  | "check-20"
  | "stop-30"
  | "rest-stop"
  | "strength-gone"
  | "stage-half"
  | "stage-full"
  | "break-even-lock"
  | "close-1550"
  | "carry"
  | "morning-gap-keep"
  | "morning-gap-against"
  | "expiry-day"
  // Not from `nextAction`: the overnight cap at 15:50 (`nightCapSell`), and
  // the carry sold because no account value was known for the cap.
  | "night-cap"
  | "night-no-equity"
  // Not from `nextAction` either: the failed break on the entry day (levels.ts).
  | "failed-break";

export interface ExitDecision {
  sell: number; // contracts to sell now; 0 = hold
  reason: ExitReason | null;
  // Changes to the position state; the caller stores them with the sale.
  update: Partial<
    Pick<
      BotPositionState,
      "checksDone" | "morningDone" | "nights" | "lockLevel"
    >
  >;
}

const hold: ExitDecision = { sell: 0, reason: null, update: {} };

/**
 * How many of `qty` contracts the rules would hold overnight to sell first so
 * that what is held after is worth at most `capPct` of `equity` at `mid`
 * (count × mid × 100), rounded so the rest is under the cap. Never more than
 * `qty`. `capPct` 0 is no cap. From the V2 research (`night_rules.py`, branch
 * research/indi-v2), where each trade's night is capped against the account.
 * The caller makes sure `mid` and `equity` are known (see `IndiBot`).
 */
export function nightCapSell(
  qty: number,
  mid: number,
  equity: number,
  capPct: number,
): number {
  if (capPct <= 0 || qty <= 0) return 0;
  if (!(mid > 0) || !(equity > 0)) return qty; // nothing is known to be under the cap
  const cap = (equity * capPct) / 100;
  if (qty * mid * 100 <= cap) return 0;
  const keep = Math.max(0, Math.floor(cap / (mid * 100)));
  return Math.min(qty, qty - keep);
}

function share(qty: number, part: number): number {
  return part >= 1 ? qty : Math.min(qty, Math.ceil(qty * part));
}

/**
 * What to do with one bot position at a closed minute. `carryDone` is true
 * when the 15:50 decision was already taken today (the caller asks once).
 */
export function nextAction(
  p: BotPositionState,
  mk: ExitMarket,
  r: ExitRules = defaultExitRules,
  carryDone = false,
): ExitDecision {
  if (p.qty <= 0 || mk.option === null) return hold;
  // After today's 15:50 decision nothing happens until the next session (a
  // position just carried must not meet its morning rule the same evening).
  if (carryDone && mk.minute >= r.eodMinute) return hold;
  const bet = p.right === "C" ? 1 : -1;
  const carried = p.nights > 0;
  if (carried && mk.minute < r.morningMinute) return hold;
  const g = mk.option / p.cost - 1;

  if (carried && p.nights === 1 && !p.morningDone) {
    const gap =
      mk.open !== null && mk.prevClose
        ? bet * (mk.open / mk.prevClose - 1) * 100
        : null;
    if (gap !== null && gap >= r.gapKeep)
      return {
        sell: share(p.qty, 0.5),
        reason: "morning-gap-keep",
        update: { morningDone: true },
      };
    return {
      sell: p.qty,
      reason: "morning-gap-against",
      update: { morningDone: true },
    };
  }
  if (mk.isExpiryDay && mk.minute >= r.expiryLastMinute)
    return { sell: p.qty, reason: "expiry-day", update: {} };
  if (mk.minute >= r.eodMinute) {
    const canCarry =
      g >= r.carryMinGain &&
      mk.sessionBeforeExpiry &&
      p.nights < r.carryMaxNights;
    if (canCarry)
      return { sell: 0, reason: "carry", update: { nights: p.nights + 1 } };
    return { sell: p.qty, reason: "close-1550", update: {} };
  }
  if (carried) {
    if (g <= r.stopOut) return { sell: p.qty, reason: "stop-30", update: {} };
    return hold;
  }
  // A late entry that is up is held to the 15:50 decision (version 2.8).
  if (r.lateHoldFrom !== null && p.entryMinute >= r.lateHoldFrom && g > 0)
    return hold;
  // The entry day: the thesis first (the signal's strength gone), then your stop.
  const strength =
    mk.strength === null || mk.strength === undefined
      ? null
      : bet * mk.strength;
  if (r.strengthOut !== null && strength !== null && strength <= r.strengthOut)
    return { sell: p.qty, reason: "strength-gone", update: {} };
  // The break-even lock: (re)set the level while the option is `arm` up, sell
  // all once the stock is back at it. A new level rides on whatever is decided.
  const level0 = p.lockLevel ?? null;
  const close = mk.close ?? mk.stock;
  let level = level0;
  if (r.lock && close !== null && g >= r.lock.arm && mk.strike && mk.years)
    level = tighterLevel(
      p.right,
      level0,
      breakEvenStock(p.right, mk.strike, mk.years, mk.option, close, p.cost),
    );
  const lockUpdate = level !== level0 ? { lockLevel: level } : {};
  if (r.lock && level !== null && close !== null && bet * (close - level) <= 0)
    return { sell: p.qty, reason: "break-even-lock", update: lockUpdate };
  const d = entryDayRest(p, mk, r, bet, g);
  return { ...d, update: { ...d.update, ...lockUpdate } };
}

/** The entry day's rules after the thesis and the lock: the staged exit, the checks, the stops. */
function entryDayRest(
  p: BotPositionState,
  mk: ExitMarket,
  r: ExitRules,
  bet: number,
  g: number,
): ExitDecision {
  // The staged stock exit: the stock's move from the signal price in S30.
  const unit = mk.unit ?? null;
  if (r.stages && unit && mk.stock !== null && p.entryStock > 0) {
    const move = (bet * (mk.stock - p.entryStock)) / (unit * p.entryStock);
    if (move <= -r.stages.full)
      return { sell: p.qty, reason: "stage-full", update: {} };
    if (!p.stageHalfSold && move <= -r.stages.half)
      return { sell: share(p.qty, 0.5), reason: "stage-half", update: {} };
  }
  const against = mk.stock !== null && bet * (mk.stock - p.entryStock) < 0;
  const held = mk.minute - p.entryMinute;
  const due = r.checks.findIndex(
    ([mins], i) => !p.checksDone.includes(i) && held >= mins,
  );
  if (due >= 0) {
    const checksDone = [...p.checksDone, due];
    if (against) {
      const [mins, part] = r.checks[due]!;
      return {
        sell: share(p.qty, part),
        reason: mins === 10 ? "check-10" : "check-20",
        update: { checksDone },
      };
    }
    return { sell: 0, reason: null, update: { checksDone } };
  }
  // A trade already cut at 10 minutes is weaker: its rest may have a tighter stop.
  const restOut = p.halfSold ? r.restStopOut : null;
  if (restOut !== null && g <= restOut && against)
    return { sell: p.qty, reason: "rest-stop", update: {} };
  if (g <= r.stopOut && against)
    return { sell: p.qty, reason: "stop-30", update: {} };
  return hold;
}
