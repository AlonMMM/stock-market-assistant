import { escape } from "../../notifications/src/telegram.js";
import type { LadderResult } from "./ladder.js";
import { parseOccSymbol } from "./options.js";

// Month/day, as in the posts this format follows.
const shortDate = (date: string) => {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}`;
};

const contracts = (n: number) => `${n} contract${n === 1 ? "" : "s"}`;

export interface StopNote {
  pct: number; // share of the premium
  price?: number; // set when the stop order was placed
  error?: string; // set when the broker refused it
}

export interface EntryNote {
  symbol: string;
  paper: boolean;
  stop?: StopNote;
}

/**
 * Entry post for the trades channel:
 *
 *   $MU | 985 Put 10/16
 *   Bought at 2.19
 *   250 contracts
 *   Stop at 1.32 (-40%)
 */
export function formatEntry(note: EntryNote, result: LadderResult): string {
  const c = parseOccSymbol(note.symbol);
  const order = result.order;
  const qty = order?.qty ?? 0;
  const filled = order?.filledQty ?? 0;
  const bought = filled > 0 && order?.filledAvgPrice;
  const stop = note.stop;
  const lines = [
    ...(note.paper ? ["🧪 PAPER"] : []),
    `<b>$${escape(c.underlying)} | ${c.strike} ${c.right === "call" ? "Call" : "Put"} ${shortDate(c.expiry)}</b>`,
    bought
      ? `Bought at ${order.filledAvgPrice!.toFixed(2)}`
      : `Bidding at ${result.prices.at(-1)?.toFixed(2) ?? "—"}, not filled yet`,
    bought && qty > filled ? `${filled} of ${contracts(qty)}` : contracts(qty),
    ...(!stop
      ? []
      : stop.price !== undefined
        ? [`Stop at ${stop.price.toFixed(2)} (-${stop.pct}%)`]
        : [
            stop.error
              ? `⚠️ No stop: ${escape(stop.error)}`
              : "No stop until it fills",
          ]),
  ];
  return lines.join("\n");
}
