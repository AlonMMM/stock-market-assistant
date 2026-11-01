import { liquidOrder, pickContract } from "../bot/picker.js";
import type { OptionQuote } from "../options.js";
import { shockRules } from "./decide.js";
import type { StrangleSettings } from "./settings.js";

// The Volume bot's leg, shared by the live bot (apps/trader/src/strangle.ts)
// and its backtest (strangle/backtest.ts): the strike nearest the delta of
// the trade's expiry, out of the money within 20% of the stock, at minPrice or
// more; with a liquidity floor, a thinner leg falls back to liquidOrder's
// strikes, the first with enough volume.

/** The deltas a leg is tried at: the setting's; the shock steps 0.05 toward the money up to 0.35. */
export function legDeltas(
  s: Pick<StrangleSettings, "delta">,
  shock: boolean,
): number[] {
  const out = [s.delta];
  if (shock)
    for (let d = s.delta + 0.05; d <= shockRules.maxDelta + 1e-9; d += 0.05)
      out.push(Math.round(d * 100) / 100);
  return out;
}

export type LegAt =
  | {
      ok: true;
      quote: OptionQuote;
      mid: number;
      delta: number;
      fallback: string; // why another strike than the delta's, in words; "" when none
    }
  | { ok: false; outcome: string; detail: string };

/**
 * The leg at one delta: the pick, then (with a floor) the volume check and the
 * liquid fallback. `onPicked` sees the picked quote before the volume check
 * (the live bot keeps its book with the signal); `volume30` is the contracts a
 * strike traded in the last 30 minutes; `words` names a contract.
 */
export async function legAt(
  quotes: OptionQuote[],
  stock: number,
  right: "call" | "put",
  day: string,
  dte: number,
  delta: number,
  s: Pick<StrangleSettings, "minPrice" | "minVolume" | "liquidFallback">,
  volume30: (contract: string) => Promise<number>,
  words: (contract: string) => string,
  onPicked?: (quote: OptionQuote) => void,
): Promise<LegAt> {
  const rules = {
    delta,
    dteMin: dte,
    dteMax: dte,
    otmScanMax: 0.2,
    maxStrikes: 16,
    minPrice: s.minPrice,
    minVolume30: s.minVolume,
    cheapFallback: false, // the Volume bot keeps its own legs: no fallback
  };
  const got = pickContract(quotes, stock, right, day, rules);
  if (got.quote) onPicked?.(got.quote);
  if (!got.ok) return { ok: false, outcome: got.reason, detail: right };
  if (s.minVolume <= 0)
    return {
      ok: true,
      quote: got.quote,
      mid: got.mid,
      delta: got.delta,
      fallback: "",
    };
  const first = got.quote.symbol;
  const volume = await volume30(first);
  if (volume >= s.minVolume)
    return {
      ok: true,
      quote: got.quote,
      mid: got.mid,
      delta: got.delta,
      fallback: "",
    };
  if (s.liquidFallback)
    for (const c of liquidOrder(
      quotes,
      stock,
      right,
      got.quote.expiry,
      got,
      rules,
    ))
      if ((await volume30(c.quote.symbol)) >= s.minVolume)
        return {
          ok: true,
          ...c,
          fallback: ` (liquid fallback: ${words(first)} traded ${volume})`,
        };
  return {
    ok: false,
    outcome: "thin",
    detail: `${words(first)}: ${volume} contracts in 30 minutes`,
  };
}
