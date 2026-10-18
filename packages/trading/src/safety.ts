import { parseOccSymbol } from "./options.js";

// Hard rule (user, 2026-10-10): the account must never be short an option.
// Amended 2026-10-17: a short option is allowed when a long option of the
// same underlying, right and expiry covers it as a debit vertical (a spread).
// Every other sell is close-only and sized from what is held; this module
// finds any state that breaks or threatens the rule so it can be raised.

export interface HeldQty {
  symbol: string;
  qty: number; // negative when short
}

export interface OpenSell {
  symbol: string;
  side: string;
  qty: number;
  filledQty: number;
  // A multi-leg order; the broker only takes one whose legs cover each other.
  legs?: unknown[] | undefined;
}

/** One short leg and the long leg that covers it, `qty` contracts of each. */
export interface SpreadPair {
  long: string;
  short: string;
  qty: number;
}

const option = (symbol: string) => {
  try {
    return parseOccSymbol(symbol);
  } catch {
    return null; // a stock
  }
};

/**
 * A long contract covers a short one when both are the same underlying,
 * right and expiry, and the long one is worth at least as much at expiry:
 * a call at or below the short strike, a put at or above it.
 */
export function covers(long: string, short: string) {
  const l = option(long);
  const s = option(short);
  return (
    l !== null &&
    s !== null &&
    l.underlying === s.underlying &&
    l.right === s.right &&
    l.expiry === s.expiry &&
    (l.right === "call" ? l.strike <= s.strike : l.strike >= s.strike)
  );
}

/**
 * The account's short options matched to long ones that cover them, each
 * short taking the covering long nearest its strike first.
 */
export function spreadPairs(positions: HeldQty[]): SpreadPair[] {
  const free = new Map(
    positions.filter((p) => p.qty > 0).map((p) => [p.symbol, p.qty]),
  );
  const pairs: SpreadPair[] = [];
  const shorts = positions.filter((p) => p.qty < 0 && option(p.symbol));
  for (const s of shorts) {
    let need = -s.qty;
    const strike = option(s.symbol)!.strike;
    const longs = [...free.keys()]
      .filter((l) => covers(l, s.symbol))
      .sort(
        (a, b) =>
          Math.abs(option(a)!.strike - strike) -
          Math.abs(option(b)!.strike - strike),
      );
    for (const long of longs) {
      if (need === 0) break;
      const qty = Math.min(need, free.get(long)!);
      if (qty <= 0) continue;
      free.set(long, free.get(long)! - qty);
      pairs.push({ long, short: s.symbol, qty });
      need -= qty;
    }
  }
  return pairs;
}

/** Contracts of `symbol` held as a leg of a spread (long or short side). */
export function pairedQty(pairs: SpreadPair[], symbol: string) {
  return pairs
    .filter((p) => p.long === symbol || p.short === symbol)
    .reduce((sum, p) => sum + p.qty, 0);
}

/**
 * Problems in the account's option positions and open orders:
 * - a short position that no long leg covers;
 * - open sell orders for more contracts than are free to sell (held and not
 *   a spread's long leg), which could go short.
 * A multi-leg order is the broker's own covered unit and is not counted.
 */
export function shortRisks(positions: HeldQty[], orders: OpenSell[]): string[] {
  const problems: string[] = [];
  const pairs = spreadPairs(positions);
  const held = new Map(positions.map((p) => [p.symbol, p.qty]));
  for (const p of positions) {
    if (p.qty >= 0) continue;
    const bare = -p.qty - pairedQty(pairs, p.symbol);
    if (bare > 0)
      problems.push(
        `SHORT ${p.symbol}: ${bare} contract${bare === 1 ? "" : "s"} sold short${bare < -p.qty ? `, ${-p.qty - bare} covered by a spread's long leg` : ""}`,
      );
  }
  const selling = new Map<string, number>();
  for (const o of orders)
    if (o.side === "sell" && !o.legs?.length)
      selling.set(
        o.symbol,
        (selling.get(o.symbol) ?? 0) + (o.qty - o.filledQty),
      );
  for (const [symbol, qty] of selling) {
    const legs = pairedQty(pairs, symbol);
    const have = Math.max((held.get(symbol) ?? 0) - legs, 0);
    if (qty > have)
      problems.push(
        legs > 0 && (held.get(symbol) ?? 0) > 0
          ? `OVERSOLD ${symbol}: open sell orders for ${qty}, ${have} free; ${legs} cover a spread's short leg`
          : `OVERSOLD ${symbol}: open sell orders for ${qty}, ${have} held`,
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
