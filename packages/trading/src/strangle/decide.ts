// The strangle's decisions (docs/tasks/backend-strangle-bot.md), pure so the
// backtest's trades can be replayed through them (scripts/strangle-parity.ts).

import type { StrangleSettings } from "./settings.js";

export type Leg = "C" | "P";
export const other = (leg: Leg): Leg => (leg === "C" ? "P" : "C");

/**
 * The side, once the stock has moved `confirmUnits` of its typical 30-minute
 * move (`unit`, a fraction of the price) from the fill; null before.
 */
export function sideOf(
  stock: number,
  stockAtFill: number,
  unit: number,
  s: Pick<StrangleSettings, "confirmUnits">,
): Leg | null {
  if (!(stock > 0) || !(stockAtFill > 0) || !(unit > 0)) return null;
  const move = stock / stockAtFill - 1;
  if (Math.abs(move) < s.confirmUnits * unit) return null;
  return move > 0 ? "C" : "P";
}

/** With the strength filter, the side stands only when the stock's t vs SPY × β agrees. */
export function strengthAgrees(side: Leg, t: number | null): boolean {
  if (t === null) return false;
  return side === "C" ? t > 0 : t < 0;
}

/** Both legs out: no side within the wait. */
export const waitedOut = (
  minute: number,
  alertMinute: number,
  s: Pick<StrangleSettings, "waitMinutes">,
) => minute - alertMinute >= s.waitMinutes;

/**
 * The exit: "giveback" once the stock is `giveBackUnits` typical 30-minute
 * moves (`unit`, a fraction of the price) back from its best since the buy
 * (its high for a call, its low for a put), "end" at the end minute.
 */
export function giveBackExit(
  stock: number,
  best: number,
  side: Leg,
  unit: number,
  minute: number,
  s: Pick<StrangleSettings, "giveBackUnits" | "endMinute">,
  held = Infinity, // minutes since the buy; under the grace only the end sells
  grace = 0,
): "giveback" | "end" | null {
  if (minute >= s.endMinute) return "end";
  if (held <= grace) return null;
  if (!(stock > 0) || !(best > 0)) return null;
  const back = side === "C" ? 1 - stock / best : stock / best - 1;
  return back >= s.giveBackUnits * unit ? "giveback" : null;
}

/**
 * The give-back on minute closes, as the backtest walks it
 * (leg_fallback.walk): the best starts at the stock at the buy and takes each
 * closed minute after the buy minute; a minute within `noStopMinutes` of the
 * buy only moves the best; the first later close `giveBackUnits` back from the
 * best sells. Recomputed from the bars on every tick, so a late bar or a
 * missed tick changes nothing.
 */
export function minuteCloseExit(
  closes: readonly { m: number; c: number }[],
  stockAtBuy: number,
  side: Leg,
  unit: number,
  buyMinute: number,
  minute: number,
  s: Pick<StrangleSettings, "giveBackUnits" | "endMinute" | "noStopMinutes">,
): { exit: "giveback" | "end" | null; best: number } {
  let best = stockAtBuy;
  for (const b of [...closes].sort((x, y) => x.m - y.m)) {
    if (b.m <= buyMinute || !(b.c > 0)) continue;
    best = bestOf(best, b.c, side);
    if (b.m - buyMinute <= s.noStopMinutes) continue;
    const back = side === "C" ? 1 - b.c / best : b.c / best - 1;
    if (back >= s.giveBackUnits * unit) return { exit: "giveback", best };
  }
  return { exit: minute >= s.endMinute ? "end" : null, best };
}

/**
 * The burst (leg_seconds.py `am`): the alert minute's close against the close
 * three minutes before, in typical 30-minute moves, up positive; null without
 * both bars.
 */
export function burstOf(
  bars: readonly { m: number; c: number }[],
  alertMinute: number,
  unit: number,
): number | null {
  const at = bars.find((b) => b.m === alertMinute)?.c;
  const before = bars.find((b) => b.m === alertMinute - 3)?.c;
  if (!(at && before && unit > 0)) return null;
  return (at / before - 1) / unit;
}

/**
 * The burst of an alert read at `second` after 09:30 at `price` (the
 * 60-second alert; f60_prefilter.py): against the close of the minute that
 * ended 3 minutes before, in typical 30-minute moves. For a minute alert
 * (second = the end of its minute) this is burstOf.
 */
export function burstAtSecond(
  bars: readonly { m: number; c: number }[],
  second: number,
  price: number,
  unit: number,
): number | null {
  const before = bars.find(
    (b) => b.m === Math.floor((second - 180) / 60) - 1,
  )?.c;
  if (!(before && price > 0 && unit > 0)) return null;
  return (price / before - 1) / unit;
}

/** With the burst filter, the side stands only when the burst points its way by burstMin. */
export function burstAgrees(
  side: Leg,
  burst: number | null | undefined,
  s: Pick<StrangleSettings, "burstFilter" | "burstMin">,
): boolean {
  if (!s.burstFilter) return true;
  if (burst === null || burst === undefined) return false;
  return (side === "C" ? burst : -burst) >= s.burstMin;
}

/**
 * Seconds from the alert to now: the alert is read on its minute's close, the
 * end of session minute `alertMinute` (09:30 New York = minute 0).
 */
export const secondsSinceAlert = (sessionSecond: number, alertMinute: number) =>
  sessionSecond - (alertMinute + 1) * 60;

/** With the cross filter, the side has to come within crossMaxSeconds of the alert. */
export const crossTooLate = (
  sessionSecond: number,
  alertMinute: number,
  s: Pick<StrangleSettings, "crossFilter" | "crossMaxSeconds">,
) =>
  s.crossFilter &&
  secondsSinceAlert(sessionSecond, alertMinute) > s.crossMaxSeconds;

/** The stock's best since the buy, in the side's direction. */
export const bestOf = (best: number, stock: number, side: Leg) =>
  side === "C" ? Math.max(best, stock) : Math.min(best, stock);

/** Contracts of the leg costing `sizePct` of `equity` at `price`. */
export function legQty(equity: number, sizePct: number, price: number): number {
  if (!(price > 0) || !(equity > 0)) return 0;
  return Math.floor((equity * sizePct) / 100 / (price * 100));
}
