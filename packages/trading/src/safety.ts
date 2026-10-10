// Hard rule (user, 2026-10-10): the account must never be short an option.
// Every sell is close-only and sized from what is held; this module finds any
// state that breaks or threatens the rule so it can be raised as an alert.

export interface HeldQty {
  symbol: string;
  qty: number; // negative when short
}

export interface OpenSell {
  symbol: string;
  side: string;
  qty: number;
  filledQty: number;
}

/**
 * Problems in the account's option positions and open orders:
 * - a short position (sold more than was held);
 * - open sell orders for more contracts than are held, which could go short.
 */
export function shortRisks(positions: HeldQty[], orders: OpenSell[]): string[] {
  const problems: string[] = [];
  const held = new Map(positions.map((p) => [p.symbol, p.qty]));
  for (const p of positions)
    if (p.qty < 0)
      problems.push(
        `SHORT ${p.symbol}: ${Math.abs(p.qty)} contract${p.qty === -1 ? "" : "s"} sold short`,
      );
  const selling = new Map<string, number>();
  for (const o of orders)
    if (o.side === "sell")
      selling.set(
        o.symbol,
        (selling.get(o.symbol) ?? 0) + (o.qty - o.filledQty),
      );
  for (const [symbol, qty] of selling) {
    const have = Math.max(held.get(symbol) ?? 0, 0);
    if (qty > have)
      problems.push(
        `OVERSOLD ${symbol}: open sell orders for ${qty}, ${have} held`,
      );
  }
  return problems;
}

/** Contracts of a position that no open sell order already covers. */
export function uncovered(
  heldQty: number,
  symbol: string,
  orders: OpenSell[],
): number {
  const selling = orders
    .filter((o) => o.symbol === symbol && o.side === "sell")
    .reduce((sum, o) => sum + (o.qty - o.filledQty), 0);
  return Math.max(0, heldQty - selling);
}
