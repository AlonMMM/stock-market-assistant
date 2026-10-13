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
