import type { OptionQuote } from "../options.js";
import { pickContract, type PickRules } from "./picker.js";

// The quote sampler (user 2026-10-26: "can you do something with [bid / ask]
// for the backtesting?"): the backtest has option trades but no quotes, so it
// charges a flat 2% a fill. The live service samples the books the bot would
// trade, to fit the spread by contract volume and price, and to price thin
// contracts (under the 200 floor) the backtest cannot judge today.

export type SampleSlot = "pick" | "in" | "out";

/**
 * One side's contracts to sample: the one the bot would pick (its delta, any
 * price), and the next listed strike toward the money ("in") and away from it
 * ("out"), same expiry.
 */
export function sampleSide(
  quotes: readonly OptionQuote[],
  spot: number,
  right: "call" | "put",
  date: string,
  rules: PickRules,
): { slot: SampleSlot; quote: OptionQuote }[] {
  const picked = pickContract(quotes, spot, right, date, {
    ...rules,
    minPrice: 0,
    cheapFallback: false,
  });
  if (!picked.ok) return [];
  const pick = picked.quote;
  const strikes = quotes
    .filter((q) => q.right === right && q.expiry === pick.expiry)
    .sort((a, b) => a.strike - b.strike);
  const at = strikes.findIndex((q) => q.symbol === pick.symbol);
  const below = strikes[at - 1];
  const above = strikes[at + 1];
  // A call's strike toward the money is lower; a put's is higher.
  const inward = right === "call" ? below : above;
  const outward = right === "call" ? above : below;
  const out: { slot: SampleSlot; quote: OptionQuote }[] = [
    { slot: "pick", quote: pick },
  ];
  if (inward) out.push({ slot: "in", quote: inward });
  if (outward) out.push({ slot: "out", quote: outward });
  return out;
}

/** The symbols due at `minute`: each one every `every` minutes, spread evenly. */
export function dueAt(
  symbols: readonly string[],
  minute: number,
  every: number,
): string[] {
  return symbols.filter((_, i) => i % every === minute % every);
}
