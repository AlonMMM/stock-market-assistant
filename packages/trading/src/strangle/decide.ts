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

/** The kept leg is sold when it closes `trailPct` under its high, or at the end minute. */
export function keptExit(
  mark: number,
  peak: number,
  minute: number,
  s: Pick<StrangleSettings, "trailPct" | "endMinute">,
): "trail" | "end" | null {
  if (minute >= s.endMinute) return "end";
  if (peak > 0 && mark <= peak * (1 - s.trailPct / 100)) return "trail";
  return null;
}

/** Contracts of each leg for a pair costing `sizePct` of `equity` at these mids. */
export function pairQty(
  equity: number,
  sizePct: number,
  callMid: number,
  putMid: number,
): number {
  const pair = (callMid + putMid) * 100;
  if (!(pair > 0) || !(equity > 0)) return 0;
  return Math.floor((equity * sizePct) / 100 / pair);
}

/** Contracts of the kept leg the wrong leg's money buys at `ask`. */
export function recycleQty(proceeds: number, ask: number): number {
  if (!(ask > 0) || !(proceeds > 0)) return 0;
  return Math.floor(proceeds / (ask * 100));
}
