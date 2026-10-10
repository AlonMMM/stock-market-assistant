// Pure rules for buying a single-leg option from a chat command such as
// "buy ORCL calls, delta 0.1, 0.5% of the portfolio" (user-confirmed
// 2026-10-10, docs/tasks/backend-option-orders.md).

export type Right = "call" | "put";

export interface OptionQuote {
  symbol: string; // OCC symbol, e.g. ORCL261016C00250000
  underlying: string;
  expiry: string; // YYYY-MM-DD
  right: Right;
  strike: number;
  bid: number;
  ask: number;
  delta: number | null;
}

// Hard cap per trade; the size itself comes with each command.
export const maxSizePct = 3;
// A spread wider than this share of the mid means no trade.
export const maxSpreadRatio = 0.1;
// The limit price never goes past 85% of the way from mid to ask.
export const ceilingFraction = 0.85;

const occ = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

export function parseOccSymbol(symbol: string) {
  const match = occ.exec(symbol);
  if (!match) throw new Error(`Not an OCC option symbol: ${symbol}`);
  const [, underlying, yy, mm, dd, right, strike] = match;
  return {
    underlying: underlying!,
    expiry: `20${yy}-${mm}-${dd}`,
    right: (right === "C" ? "call" : "put") as Right,
    strike: Number(strike) / 1000,
  };
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);

/** The coming Friday (today when today is Friday). */
export function comingFriday(today: string): string {
  const day = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, (5 - day + 7) % 7);
}

/**
 * The two expiries offered side by side: the nearest listed one, and the
 * coming Friday's (the last listed expiry up to that Friday, so a Friday
 * holiday falls back to Thursday). Null when nothing is listed.
 */
export function expiryChoices(
  expiries: string[],
  today: string,
): { nearest: string; friday: string | null } | null {
  const listed = [...new Set(expiries)].filter((e) => e >= today).sort();
  if (!listed.length) return null;
  const friday = comingFriday(today);
  const upToFriday = listed.filter((e) => e <= friday);
  return { nearest: listed[0]!, friday: upToFriday.at(-1) ?? null };
}

/** The quote whose |delta| is closest to the target; ties go to the cheaper. */
export function pickByDelta(
  quotes: OptionQuote[],
  target: number,
): OptionQuote | null {
  let best: OptionQuote | null = null;
  let bestGap = Infinity;
  for (const q of quotes) {
    if (q.delta === null || !(q.ask > 0)) continue;
    const gap = Math.abs(Math.abs(q.delta) - Math.abs(target));
    if (
      gap < bestGap - 1e-12 ||
      (Math.abs(gap - bestGap) <= 1e-12 && best && q.ask < best.ask)
    ) {
      best = q;
      bestGap = gap;
    }
  }
  return best;
}

/** Spread as a share of the mid; a missing bid always fails. */
export function spreadCheck(q: Pick<OptionQuote, "bid" | "ask">) {
  const mid = (q.bid + q.ask) / 2;
  const spread = q.ask - q.bid;
  const ratio = mid > 0 ? spread / mid : Infinity;
  return {
    mid,
    spread,
    ratio,
    ok: q.bid > 0 && q.ask >= q.bid && ratio <= maxSpreadRatio + 1e-9,
  };
}

// Options quote in $0.01 below $3 and $0.05 from $3 (penny-program names);
// a contract outside the program can reject a penny price.
export const tick = (price: number) => (price < 3 ? 0.01 : 0.05);

export function roundToTick(price: number, mode: "up" | "down"): number {
  const t = tick(price);
  const steps = price / t;
  const n = mode === "up" ? Math.ceil(steps - 1e-9) : Math.floor(steps + 1e-9);
  return Math.round(n * t * 100) / 100;
}

/** Highest limit price allowed by the quote: mid + 85% of (ask − mid). */
export function ceilingPrice(q: Pick<OptionQuote, "bid" | "ask">): number {
  const mid = (q.bid + q.ask) / 2;
  return roundToTick(mid + ceilingFraction * (q.ask - mid), "down");
}

/**
 * Limit price for step `i` of `steps`: from the mid (rounded down) at step 0
 * to the ceiling at the last step.
 */
export function stepPrice(
  q: Pick<OptionQuote, "bid" | "ask">,
  i: number,
  steps: number,
): number {
  const mid = (q.bid + q.ask) / 2;
  const top = ceilingPrice(q);
  const start = Math.min(roundToTick(mid, "down"), top);
  if (steps <= 0 || i >= steps) return top;
  return Math.min(
    top,
    roundToTick(start + ((top - start) * i) / steps, "down"),
  );
}

/** Whole contracts whose cost at `price` stays within `sizePct` of equity. */
export function sizeContracts(equity: number, sizePct: number, price: number) {
  if (!(sizePct > 0) || sizePct > maxSizePct)
    throw new Error(`Size must be above 0% and at most ${maxSizePct}%`);
  if (!(equity > 0)) throw new Error("Account equity is not positive");
  if (!(price > 0)) throw new Error("Price is not positive");
  const budget = (equity * sizePct) / 100;
  const qty = Math.floor(budget / (price * 100) + 1e-9);
  return { qty, budget, cost: qty * price * 100 };
}
