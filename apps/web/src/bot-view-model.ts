import type { BotView } from "../../../packages/trading/src/bot-api.js";

/**
 * Today's signals with an entry wherever a position says so. A signal can
 * keep a miss as its outcome although an account bought it: on 2026-10-26
 * CRWV was bought at Alpaca and the IBKR leg's error was written over the
 * signal, so the Bot tab showed 0 bought (user: "we did bought"). The
 * position is the record of the buy.
 */
export function withEntries(view: BotView): BotView {
  const held = new Map(
    view.positions.map((p) => [`${p.day} ${p.symbol}`, p.dry] as const),
  );
  return {
    ...view,
    signals: view.signals.map((s) => {
      const dry = held.get(`${s.day} ${s.symbol}`);
      const entered = s.outcome === "bought" || s.outcome === "would-buy";
      if (dry === undefined || entered) return s;
      return { ...s, outcome: dry ? "would-buy" : "bought" };
    }),
  };
}

/** Whether a signal was bought (or would be, in a dry run). */
export const isEntry = (outcome: string) =>
  outcome === "bought" || outcome === "would-buy";
