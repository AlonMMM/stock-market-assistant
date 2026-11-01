import { blackScholes, impliedVolatility } from "../option-estimate.js";

// The break-even lock's level (version 2.9; scripts/research/indi_bt/sim.py
// `be_level`, research/indi-v2): the stock price at which the option would be
// worth `target` (what was paid), at the option's implied volatility now. The
// rate is the research backtest's (params.json `rate`), so both sides set the
// same level.
export const lockRate = 0.045;

/**
 * The stock price where the option is worth `target` at the volatility implied
 * by `optionPrice` with the stock at `stock`; null when no volatility prices it
 * (the price is outside the model's range) or the inputs are not usable.
 */
export function breakEvenStock(
  right: "C" | "P",
  strike: number,
  years: number,
  optionPrice: number,
  stock: number,
  target: number,
  rate = lockRate,
): number | null {
  if (!(strike > 0 && years > 0 && optionPrice > 0 && stock > 0 && target > 0))
    return null;
  const side = right === "C" ? "call" : "put";
  const vol = impliedVolatility(side, optionPrice, stock, strike, years, rate);
  if (vol === null) return null;
  // A call is worth less as the stock falls, a put as it rises: look between
  // half the stock price and now (a call), or now and 1.5x (a put).
  const call = right === "C";
  let lo = call ? stock * 0.5 : stock;
  let hi = call ? stock : stock * 1.5;
  for (let i = 0; i < 50; i++) {
    const m = (lo + hi) / 2;
    const above = blackScholes(side, m, strike, years, vol, rate) > target;
    if (above === call) hi = m;
    else lo = m;
  }
  return (lo + hi) / 2;
}

/** Of two lock levels, the tighter one: the higher for a call, the lower for a put. */
export function tighterLevel(
  right: "C" | "P",
  a: number | null,
  b: number | null,
): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return right === "C" ? Math.max(a, b) : Math.min(a, b);
}
