import type { OptionQuote } from "../options.js";

// The bot's contract (docs/tasks/backend-indi-bot.md), chosen the way the
// backtest chose it (`pick` in scripts/research/indi_bt/sim.py): the nearest
// expiry 1–7 days out, out-of-the-money strikes within 20% of the stock (the
// 16 nearest), the delta closest to the target. Too thin means no trade. Too
// cheap means no trade too, unless the cheap fallback is on (version 2.6): then
// the nearest strike toward the money that costs the minimum or more
// (cheap_up.py "cheap" in the research; it adds money at the same worst drop).

export interface PickRules {
  delta: number;
  dteMin: number;
  dteMax: number;
  otmScanMax: number; // farthest strike, as a share of the stock price
  maxStrikes: number;
  minPrice: number; // the contract's mid
  minVolume30: number; // contracts traded in the last 30 minutes
  // Under minPrice, take the cheapest strike toward the money at minPrice or more.
  cheapFallback: boolean;
}

export const defaultPickRules: PickRules = {
  delta: 0.15,
  dteMin: 1,
  dteMax: 7,
  otmScanMax: 0.2,
  maxStrikes: 16,
  minPrice: 0.2,
  minVolume30: 200,
  cheapFallback: false,
};

export type Picked =
  | {
      ok: true;
      quote: OptionQuote;
      mid: number;
      delta: number;
      // set when the 0.15-delta contract was too cheap and the fallback chose this one
      fallback?: "cheap";
    }
  | {
      ok: false;
      reason: "no_expiry" | "no_strikes" | "no_prices" | "too_cheap";
      // too_cheap: the contract it would have taken, so its book can be kept
      quote?: OptionQuote;
    };

const day = 86_400_000;
export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * day)
    .toISOString()
    .slice(0, 10);

/** The expiry window to ask the chain for, as [from, to] dates. */
export function expiryWindow(
  date: string,
  r: PickRules = defaultPickRules,
): [string, string] {
  return [addDays(date, r.dteMin), addDays(date, r.dteMax)];
}

/**
 * The contract for a signal on `date` with the stock at `spot`, from one side
 * of the chain. The volume check needs bars and is the caller's.
 */
export function pickContract(
  quotes: readonly OptionQuote[],
  spot: number,
  right: "call" | "put",
  date: string,
  r: PickRules = defaultPickRules,
): Picked {
  const [from, to] = expiryWindow(date, r);
  const side = quotes.filter(
    (q) => q.right === right && q.expiry >= from && q.expiry <= to,
  );
  const expiry = side.map((q) => q.expiry).sort()[0];
  if (!expiry) return { ok: false, reason: "no_expiry" };
  const call = right === "call";
  const strikes = side
    .filter((q) => q.expiry === expiry)
    .filter((q) =>
      call
        ? spot <= q.strike && q.strike <= spot * (1 + r.otmScanMax)
        : spot * (1 - r.otmScanMax) <= q.strike && q.strike <= spot,
    )
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
    .slice(0, r.maxStrikes);
  if (strikes.length === 0) return { ok: false, reason: "no_strikes" };
  const priced: { quote: OptionQuote; mid: number; delta: number }[] = [];
  for (const q of strikes) {
    if (q.delta === null || !(q.bid > 0) || !(q.ask > 0)) continue;
    priced.push({
      quote: q,
      mid: (q.bid + q.ask) / 2,
      delta: Math.abs(q.delta),
    });
  }
  let best: (typeof priced)[number] | null = null;
  for (const c of priced)
    if (!best || Math.abs(c.delta - r.delta) < Math.abs(best.delta - r.delta))
      best = c;
  if (!best) return { ok: false, reason: "no_prices" };
  if (best.mid >= r.minPrice) return { ok: true, ...best };
  const cheapest = r.cheapFallback
    ? cheapUp(priced, best.delta, r.minPrice)
    : null;
  if (cheapest) return { ok: true, ...cheapest, fallback: "cheap" };
  return { ok: false, reason: "too_cheap", quote: best.quote };
}

/**
 * The cheap fallback: of the strikes at `minPrice` or more that are at least as
 * close to the money as the too-cheap pick (delta as high or higher), the
 * cheapest one, the nearest step toward the money that pays the minimum.
 */
function cheapUp<T extends { mid: number; delta: number }>(
  priced: readonly T[],
  delta: number,
  minPrice: number,
): T | null {
  let out: T | null = null;
  for (const c of priced) {
    if (c.mid < minPrice || c.delta < delta) continue;
    if (!out || c.mid < out.mid) out = c;
  }
  return out;
}

/**
 * The liquid fallback's strikes, in the order to try them (the Volume bot,
 * user 2026-10-26 "implement the liquid fallback"; leg_fb2.py "liquid": on the
 * 167 watchlist stocks it made the most at the live limits with a smaller
 * worst drop). When the picked contract is too thin: first further out, down
 * to delta `band[0]`, the one nearest the target first; then toward the
 * money, up to `band[1]`. Each must cost `minPrice` or more; the caller takes
 * the first with enough volume.
 */
export function liquidOrder(
  quotes: readonly OptionQuote[],
  spot: number,
  right: "call" | "put",
  expiry: string,
  picked: { quote: OptionQuote; delta: number },
  r: Pick<PickRules, "otmScanMax" | "maxStrikes" | "minPrice">,
  band: readonly [number, number] = [0.25, 0.5],
): { quote: OptionQuote; mid: number; delta: number }[] {
  const call = right === "call";
  const priced: { quote: OptionQuote; mid: number; delta: number }[] = [];
  for (const q of quotes
    .filter((q) => q.right === right && q.expiry === expiry)
    .filter((q) =>
      call
        ? spot <= q.strike && q.strike <= spot * (1 + r.otmScanMax)
        : spot * (1 - r.otmScanMax) <= q.strike && q.strike <= spot,
    )
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
    .slice(0, r.maxStrikes)) {
    if (q.symbol === picked.quote.symbol) continue;
    if (q.delta === null || !(q.bid > 0) || !(q.ask > 0)) continue;
    const mid = (q.bid + q.ask) / 2;
    if (mid < r.minPrice) continue;
    priced.push({ quote: q, mid, delta: Math.abs(q.delta) });
  }
  const [low, high] = band;
  const out = priced
    .filter((c) => low <= c.delta && c.delta < picked.delta)
    .sort((a, b) => b.delta - a.delta);
  const toward = priced
    .filter((c) => picked.delta < c.delta && c.delta <= high)
    .sort((a, b) => a.delta - b.delta);
  return [...out, ...toward];
}
