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
): "giveback" | "end" | null {
  if (minute >= s.endMinute) return "end";
  if (!(stock > 0) || !(best > 0)) return null;
  const back = side === "C" ? 1 - stock / best : stock / best - 1;
  return back >= s.giveBackUnits * unit ? "giveback" : null;
}

/** The stock's best since the buy, in the side's direction. */
export const bestOf = (best: number, stock: number, side: Leg) =>
  side === "C" ? Math.max(best, stock) : Math.min(best, stock);

/** Contracts of the leg costing `sizePct` of `equity` at `price`. */
export function legQty(equity: number, sizePct: number, price: number): number {
  if (!(price > 0) || !(equity > 0)) return 0;
  return Math.floor((equity * sizePct) / 100 / (price * 100));
}
