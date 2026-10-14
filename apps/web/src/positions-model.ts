import {
  coreClose,
  newYork,
  previousSessions,
} from "../../../packages/market-data/src/calendar.js";
import type { PortfolioPosition } from "../../../packages/trading/src/portfolio.js";

const round = (n: number, places = 2) =>
  Math.round((n + Number.EPSILON) * 10 ** places) / 10 ** places;

export type PositionView = "close" | "overnight";

export interface PositionNumbers {
  price: number | null;
  value: number | null;
  pnl: number | null;
  pnlPct: number | null;
  sharePct: number | null;
  sinceClose: number | null;
  underlyingPrice: number | null;
}

/** Revalue one holding consistently for the selected portfolio view. */
export function positionNumbers(
  p: PortfolioPosition,
  view: PositionView,
  equity: number,
): PositionNumbers {
  const price =
    view === "overnight"
      ? p.option
        ? p.estimatedPrice
        : p.overnightPrice
      : p.price;
  const multiplier = p.option ? 100 : 1;
  const adjustment =
    price === null || p.price === null
      ? null
      : round((price - p.price) * p.qty * multiplier);
  const value =
    price === null
      ? null
      : round(
          p.value === null
            ? price * p.qty * multiplier
            : p.value + (adjustment ?? 0),
        );
  const pnl =
    price === null
      ? null
      : round(
          p.pnl === null
            ? (price - p.entry) * p.qty * multiplier
            : p.pnl + (adjustment ?? 0),
        );
  const pnlPct =
    pnl === null || !(p.cost > 0) ? null : round((pnl / p.cost) * 100, 1);
  const sharePct =
    value === null || !(equity > 0) ? null : round((value / equity) * 100, 1);
  const sinceClose =
    view !== "overnight" || price === null || p.price === null
      ? null
      : round((price - p.price) * p.qty * multiplier);
  return {
    price,
    value: view === "close" ? p.value : value,
    pnl: view === "close" ? p.pnl : pnl,
    pnlPct: view === "close" ? p.pnlPct : pnlPct,
    sharePct,
    sinceClose,
    underlyingPrice:
      p.option && view === "close"
        ? (p.estimateBreakdown?.underlyingReference ?? p.underlyingPrice)
        : p.underlyingPrice,
  };
}

/** Long-option delta-adjusted underlying exposure, in dollars. */
export function optionDeltaExposure(
  contracts: number,
  underlyingPrice: number,
  delta: number,
) {
  return contracts * 100 * underlyingPrice * delta;
}

/** The US session whose chart is worth opening now: today's, or the last. */
export function chartSession(now = Date.now()): string {
  const { date, minute } = newYork(now);
  // Pre-market bars start at 04:00 New York.
  return coreClose(date) !== null && minute >= 240
    ? date
    : previousSessions(date, 1)[0]!;
}
