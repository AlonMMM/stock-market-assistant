import type { Contract } from "../../../packages/trading/src/portfolio.js";

// Money, percentages and contract names as the Portfolio pages show them.

export const usd = (n: number, digits = 0) =>
  `$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
export const signedUsd = (n: number) => `${n >= 0 ? "+" : "−"}${usd(n)}`;
export const signedPct = (n: number) =>
  `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`;
/** A class suffix for a number's colour: " up", " down" or nothing. */
export function tone(n: number | null): string {
  if (n === null || n === 0) return "";
  return n > 0 ? " up" : " down";
}
const expiry = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
});
export const expiryLabel = (date: string) =>
  expiry.format(Date.parse(`${date}T00:00:00Z`));

export const optionName = (c: Contract) =>
  c.option
    ? `${c.underlying} ${c.option.strike} ${c.option.right === "call" ? "Call" : "Put"}`
    : c.symbol;
