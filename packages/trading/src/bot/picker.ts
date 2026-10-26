import type { OptionQuote } from "../options.js";

// The bot's contract (docs/tasks/backend-indi-bot.md), chosen the way the
// backtest chose it (`pick` in scripts/research/indi_bt/sim.py): the nearest
// expiry 1–7 days out, out-of-the-money strikes within 20% of the stock (the
// 16 nearest), the delta closest to the target. Too cheap or too thin means no
// trade; there is never a fallback to another contract.

export interface PickRules {
  delta: number;
  dteMin: number;
  dteMax: number;
  otmScanMax: number; // farthest strike, as a share of the stock price
  maxStrikes: number;
  minPrice: number; // the contract's mid
  minVolume30: number; // contracts traded in the last 30 minutes
}

export const defaultPickRules: PickRules = {
  delta: 0.15,
  dteMin: 1,
  dteMax: 7,
  otmScanMax: 0.2,
  maxStrikes: 16,
  minPrice: 0.2,
  minVolume30: 200,
};

export type Picked =
  | { ok: true; quote: OptionQuote; mid: number; delta: number }
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
  let best: { quote: OptionQuote; mid: number; delta: number } | null = null;
  for (const q of strikes) {
    if (q.delta === null || !(q.bid > 0) || !(q.ask > 0)) continue;
    const delta = Math.abs(q.delta);
    if (!best || Math.abs(delta - r.delta) < Math.abs(best.delta - r.delta))
      best = { quote: q, mid: (q.bid + q.ask) / 2, delta };
  }
  if (!best) return { ok: false, reason: "no_prices" };
  if (best.mid < r.minPrice)
    return { ok: false, reason: "too_cheap", quote: best.quote };
  return { ok: true, ...best };
}
