// Where the stock trades among an option chain's strikes.

/**
 * Index of the first strike above the stock price: the stock-price row is
 * shown just before it (after the last strike when every strike is at or
 * below the price). Null without a price. Strikes must be sorted.
 */
export function priceRowIndex(strikes: number[], price: number | null) {
  if (price === null || strikes.length === 0) return null;
  const i = strikes.findIndex((s) => s > price);
  return i < 0 ? strikes.length : i;
}

/** A call is in the money below the stock price, a put above it. */
export const inTheMoney = (
  right: "call" | "put",
  strike: number,
  price: number | null,
) => price !== null && (right === "call" ? strike < price : strike > price);

// Option prices move in ticks: a cent below $3, 5 cents from $3
// (packages/trading/src/options.ts).
export const optionTick = (price: number) => (price < 3 ? 0.01 : 0.05);

/** The price on the nearest tick, as the ticket shows it. */
export function onOptionTick(price: number): number {
  const t = optionTick(price);
  return Math.round(Math.round(price / t) * t * 100) / 100;
}

/** One tick up or down from the price typed, never below one cent. */
export function stepOptionPrice(price: number, up: boolean): number {
  const t = optionTick(up ? price : price - 1e-9);
  return Math.max(0.01, onOptionTick(price + (up ? t : -t)));
}
