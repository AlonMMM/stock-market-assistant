import { coreClose, newYorkToUtc } from "../../market-data/src/calendar.js";
import type { Right } from "./options.js";

// Model value of a long option while its market is closed. This is an
// estimate, not an executable quote.
//
// Preferred model: Black-Scholes repricing. The volatility is implied from
// the last option mark at the underlying price of that same moment, then the
// option is repriced at the latest underlying print and the remaining time to
// expiry. Unlike a delta/gamma/theta expansion, this stays correct for large
// moves (delta saturates at 0 or 1) and for options close to expiry (value
// converges to intrinsic). When no volatility can be found, the Greeks
// expansion is used instead.

// Assumed annual risk-free rate; only a small effect on an overnight change.
export const riskFreeRate = 0.04;
const yearMs = 365 * 86400000;

export interface OptionEstimateInput {
  right: Right;
  strike: number;
  expiry: string; // YYYY-MM-DD
  mark: number; // option mark when it last traded or was quoted
  markAt: number; // ms
  reference: number; // underlying price at `markAt`
  spot: number; // latest underlying price
  now: number; // ms
  impliedVolatility: number | null; // the feed's IV, a fallback
  greeks: { delta: number; gamma: number; theta: number } | null;
}

export interface OptionEstimate {
  price: number;
  model: "black-scholes" | "greeks";
  volatility: number | null; // annualized σ used by Black-Scholes
  // Parts of the change from the mark; they sum to price − mark before the
  // floor at intrinsic value.
  moveEffect: number; // from the underlying moving
  timeEffect: number; // from time passing
  elapsedDays: number;
}

// Abramowitz–Stegun 7.1.26; error below 1.5e-7.
function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

export function intrinsic(right: Right, spot: number, strike: number) {
  return Math.max(0, right === "call" ? spot - strike : strike - spot);
}

/** European Black-Scholes price; `years` ≤ 0 gives intrinsic value. */
export function blackScholes(
  right: Right,
  spot: number,
  strike: number,
  years: number,
  volatility: number,
  rate = riskFreeRate,
): number {
  if (!(years > 0) || !(volatility > 0)) return intrinsic(right, spot, strike);
  const sd = volatility * Math.sqrt(years);
  const d1 =
    (Math.log(spot / strike) + (rate + (volatility * volatility) / 2) * years) /
    sd;
  const d2 = d1 - sd;
  const discount = strike * Math.exp(-rate * years);
  return right === "call"
    ? spot * normCdf(d1) - discount * normCdf(d2)
    : discount * normCdf(-d2) - spot * normCdf(-d1);
}

/** Volatility that reproduces `price`, by bisection; null when none does. */
export function impliedVolatility(
  right: Right,
  price: number,
  spot: number,
  strike: number,
  years: number,
  rate = riskFreeRate,
): number | null {
  if (!(years > 0) || !(price > 0)) return null;
  let low = 0.005;
  let high = 5;
  const at = (v: number) => blackScholes(right, spot, strike, years, v, rate);
  if (price < at(low) || price > at(high)) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    if (at(mid) < price) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Expiry at the US options close (16:00 New York, 13:00 on early closes). */
export function expiryTime(expiry: string): number {
  try {
    return newYorkToUtc(expiry, coreClose(expiry) ?? 960);
  } catch {
    return Date.parse(`${expiry}T20:00:00Z`);
  }
}

export function estimateOption(
  input: OptionEstimateInput,
): OptionEstimate | null {
  const { right, strike, mark, reference, spot } = input;
  if (!(mark >= 0) || !(reference > 0) || !(spot > 0)) return null;
  const elapsedDays = Math.max(0, (input.now - input.markAt) / 86400000);
  const expiresAt = expiryTime(input.expiry);
  const yearsThen = (expiresAt - input.markAt) / yearMs;
  const yearsNow = (expiresAt - Math.max(input.now, input.markAt)) / yearMs;
  const floor = intrinsic(right, spot, strike);

  const volatility =
    impliedVolatility(right, mark, reference, strike, yearsThen) ??
    (input.impliedVolatility !== null && input.impliedVolatility > 0
      ? input.impliedVolatility
      : null);
  if (volatility !== null && yearsThen > 0) {
    const value = (s: number, years: number) =>
      blackScholes(right, s, strike, years, volatility);
    const then = value(reference, yearsThen);
    const moved = value(spot, yearsThen);
    const decayed = value(spot, yearsNow);
    const moveEffect = moved - then;
    const timeEffect = decayed - moved;
    return {
      price: Math.max(floor, mark + moveEffect + timeEffect),
      model: "black-scholes",
      volatility,
      moveEffect,
      timeEffect,
      elapsedDays,
    };
  }
  if (!input.greeks) return null;
  const { delta, gamma, theta } = input.greeks;
  const move = spot - reference;
  const moveEffect = delta * move + 0.5 * gamma * move * move;
  // Theta cannot take more than the time value left in the mark.
  const timeValue = Math.max(0, mark - intrinsic(right, reference, strike));
  const timeEffect =
    timeValue > 0 ? Math.max(theta * elapsedDays, -timeValue) : 0;
  return {
    price: Math.max(floor, 0, mark + moveEffect + timeEffect),
    model: "greeks",
    volatility: null,
    moveEffect,
    timeEffect,
    elapsedDays,
  };
}
