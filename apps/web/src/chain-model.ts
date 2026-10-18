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

/** One strike of a side-by-side chain: its call and its put, if listed. */
export interface ChainRow<Q> {
  strike: number;
  call: Q | null;
  put: Q | null;
}

/** Calls and puts of one expiry joined by strike, low to high. */
export function pairStrikes<Q extends { strike: number }>(
  calls: Q[],
  puts: Q[],
): ChainRow<Q>[] {
  const rows = new Map<number, ChainRow<Q>>();
  const row = (strike: number) => {
    let r = rows.get(strike);
    if (!r) rows.set(strike, (r = { strike, call: null, put: null }));
    return r;
  };
  for (const q of calls) row(q.strike).call = q;
  for (const q of puts) row(q.strike).put = q;
  return [...rows.values()].sort((a, b) => a.strike - b.strike);
}

const newYorkDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
});

/** Calendar days from today in New York to an expiry (YYYY-MM-DD). */
export function daysToExpiry(expiry: string, now: number) {
  const today = Date.parse(`${newYorkDate.format(now)}T00:00:00Z`);
  return Math.round((Date.parse(`${expiry}T00:00:00Z`) - today) / 86_400_000);
}

export const daysLabel = (days: number) =>
  days <= 0 ? "today" : days === 1 ? "1 day" : `${days} days`;

/** A standard monthly expiry: the month's third Friday. Others are weeklies. */
export function isMonthly(expiry: string) {
  const d = new Date(`${expiry}T00:00:00Z`);
  return d.getUTCDay() === 5 && d.getUTCDate() >= 15 && d.getUTCDate() <= 21;
}

const tabDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});

/** "Oct 19 '26", as on an IBKR expiry tab. */
export const expiryTab = (expiry: string) =>
  `${tabDate.format(Date.parse(`${expiry}T00:00:00Z`))} '${expiry.slice(2, 4)}`;
