import { escape } from "../../notifications/src/telegram.js";
import type { ExitResult } from "./exit.js";
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
  qty?: number; // contracts the stop covers
  error?: string; // set when the broker refused it
}

export interface EntryNote {
  symbol: string;
  paper: boolean;
  stop?: StopNote;
  note?: string; // an extra line, such as "Ordered off hours"
  // What the whole position cost, as % of the account (user 2026-10-12).
  sharePct?: number;
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
    ...(bought && note.sharePct !== undefined
      ? [
          `${note.sharePct < 0.1 ? note.sharePct.toFixed(2) : note.sharePct.toFixed(1)}% of the portfolio`,
        ]
      : []),
    ...(note.note ? [escape(note.note)] : []),
    ...(!stop
      ? []
      : stop.price === undefined
        ? [
            stop.error
              ? `⚠️ No stop: ${escape(stop.error)}`
              : "No stop until it fills",
          ]
        : [
            `Stop at ${stop.price.toFixed(2)} (-${stop.pct}%)`,
            ...(stop.qty !== undefined && stop.qty < filled
              ? [`⚠️ The stop covers ${stop.qty} of ${filled}`]
              : []),
          ]),
  ];
  return lines.join("\n");
}

const dollars = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/**
 * Exit post, sent as a reply to the entry post when its id is known:
 *
 *   $MU | 985 Put 10/16
 *   Sold 125 of 250 at 1.50
 *   Profit $2,500 (+12%)
 *   Stop at 1.32 on the remaining 125
 */
export function formatExit(
  note: { symbol: string; paper: boolean },
  result: ExitResult,
): string {
  const c = parseOccSymbol(note.symbol);
  const pnl =
    result.price === null
      ? null
      : (result.price - result.entry) * result.sold * 100;
  const pct =
    result.price === null || !(result.entry > 0)
      ? null
      : ((result.price - result.entry) / result.entry) * 100;
  const lines = [
    ...(note.paper ? ["🧪 PAPER"] : []),
    `<b>$${escape(c.underlying)} | ${c.strike} ${c.right === "call" ? "Call" : "Put"} ${shortDate(c.expiry)}</b>`,
    result.remaining === 0
      ? `Out, sold ${result.sold} at ${result.price?.toFixed(2) ?? "—"}`
      : `Sold ${result.sold} of ${result.held} at ${result.price?.toFixed(2) ?? "—"}`,
    ...(pnl === null
      ? []
      : [
          `${pnl >= 0 ? "Profit" : "Loss"} ${dollars(pnl)}${pct === null ? "" : ` (${pct >= 0 ? "+" : "-"}${Math.abs(pct).toFixed(0)}%)`}`,
        ]),
    ...(result.stop
      ? [
          result.stop.error
            ? `⚠️ No stop on the remaining ${result.remaining}: ${escape(result.stop.error)}`
            : `Stop at ${result.stop.price.toFixed(2)} on the remaining ${result.remaining}`,
        ]
      : []),
  ];
  return lines.join("\n");
}

/** A stop order that sold contracts at the broker. */
export interface StopFill {
  symbol: string;
  sold: number;
  price: number; // average sale price
  stopPrice: number | null; // where the stop was set
  entry: number | null; // average entry price, when it is known
  remaining: number; // contracts still held after it
}

/**
 * Stop-out post, sent as a reply to the entry post and as a comment under it:
 *
 *   🛑 STOPPED OUT
 *   $MU | 985 Put 10/16
 *   Sold 250 at 1.30 (stop 1.32)
 *   Loss $22,250 (-41%)
 */
export function formatStopOut(
  note: { symbol: string; paper: boolean },
  fill: StopFill,
): string {
  const c = parseOccSymbol(note.symbol);
  const pnl =
    fill.entry === null ? null : (fill.price - fill.entry) * fill.sold * 100;
  const pct =
    fill.entry === null || !(fill.entry > 0)
      ? null
      : ((fill.price - fill.entry) / fill.entry) * 100;
  return [
    ...(note.paper ? ["🧪 PAPER"] : []),
    "🛑 <b>STOPPED OUT</b>",
    `<b>$${escape(c.underlying)} | ${c.strike} ${c.right === "call" ? "Call" : "Put"} ${shortDate(c.expiry)}</b>`,
    `Sold ${fill.sold} at ${fill.price.toFixed(2)}${fill.stopPrice === null ? "" : ` (stop ${fill.stopPrice.toFixed(2)})`}`,
    ...(pnl === null
      ? []
      : [
          `${pnl >= 0 ? "Profit" : "Loss"} ${dollars(pnl)}${pct === null ? "" : ` (${pct >= 0 ? "+" : "-"}${Math.abs(pct).toFixed(0)}%)`}`,
        ]),
    ...(fill.remaining > 0 ? [`${contracts(fill.remaining)} still held`] : []),
  ].join("\n");
}
