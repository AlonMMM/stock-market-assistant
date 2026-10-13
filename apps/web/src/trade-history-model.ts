import type { ClosedTrade } from "../../../packages/trading/src/portfolio.js";

/** Sum dollars first; trade percentage returns cannot be added together. */
export function cumulativeTrades(
  trades: ClosedTrade[],
  baseEquity: number | null,
) {
  let total = 0;
  return [...trades]
    .sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt))
    .map((trade) => {
      total += trade.pnl;
      const pnl = Math.round(total * 100) / 100;
      return {
        trade,
        time: Date.parse(trade.closedAt),
        pnl,
        pct:
          baseEquity !== null && baseEquity > 0
            ? (pnl / baseEquity) * 100
            : null,
      };
    });
}
