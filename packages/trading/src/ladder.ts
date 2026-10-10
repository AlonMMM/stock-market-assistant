import type { Order, TradingClient } from "./alpaca-trading.js";
import {
  roundToTick,
  spreadCheck,
  stepPrice,
  type OptionQuote,
} from "./options.js";

export interface LadderOptions {
  steps?: number; // raises after the first price; the last one is the ceiling
  intervalMs?: number;
  maxPrice?: number; // budget cap per contract
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export type LadderStatus =
  | "rejected-spread" // spread too wide before sending: nothing was sent
  | "rejected-budget" // the cap is below the first price: nothing was sent
  | "filled"
  | "partial" // left working at its last price
  | "open" // nothing filled yet, left working at its last price
  | "closed"; // canceled, expired or rejected by the broker

export interface LadderResult {
  status: LadderStatus;
  quote: OptionQuote;
  spreadRatio: number;
  prices: number[];
  order?: Order;
  // Raising stopped early because the spread widened past the limit.
  spreadWidened?: boolean;
}

const finished = new Set([
  "filled",
  "canceled",
  "expired",
  "rejected",
  "done_for_day",
]);

function status(order: Order): LadderStatus {
  if (order.status === "filled") return "filled";
  if (finished.has(order.status)) return "closed";
  return order.filledQty > 0 ? "partial" : "open";
}

/**
 * Buys `qty` contracts with a day limit order that starts at the mid and is
 * raised every `intervalMs` toward the ceiling (85% of mid → ask), using a
 * fresh quote each time. It never sends when the spread is too wide, never
 * lowers the price, and leaves an unfilled remainder working.
 */
export async function buyWithLadder(
  client: TradingClient,
  symbol: string,
  qty: number,
  options: LadderOptions = {},
): Promise<LadderResult> {
  const steps = options.steps ?? 5;
  const interval = options.intervalMs ?? 3000;
  const sleep =
    options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = options.log ?? (() => {});
  const cap =
    options.maxPrice === undefined
      ? Infinity
      : roundToTick(options.maxPrice, "down");

  let quote = await client.quote(symbol);
  let check = spreadCheck(quote);
  if (!check.ok)
    return {
      status: "rejected-spread",
      quote,
      spreadRatio: check.ratio,
      prices: [],
    };
  let price = Math.min(stepPrice(quote, 0, steps), cap);
  if (!(price > 0) || price < roundToTick(check.mid, "down") - 1e-9)
    return {
      status: "rejected-budget",
      quote,
      spreadRatio: check.ratio,
      prices: [],
    };

  let order = await client.buyLimit(symbol, qty, price);
  const prices = [price];
  log(`sent ${qty} @ ${price.toFixed(2)} (bid ${quote.bid}, ask ${quote.ask})`);
  let spreadWidened = false;

  for (let i = 1; i <= steps; i++) {
    await sleep(interval);
    order = await client.order(order.id);
    if (status(order) === "filled" || status(order) === "closed") break;
    quote = await client.quote(symbol);
    check = spreadCheck(quote);
    if (!check.ok) {
      spreadWidened = true;
      log(`spread ${(check.ratio * 100).toFixed(1)}% of mid; stopped raising`);
      break;
    }
    const next = Math.min(stepPrice(quote, i, steps), cap);
    if (next <= price + 1e-9) continue;
    order = await client.replace(order.id, next);
    price = next;
    prices.push(price);
    log(`raised to ${price.toFixed(2)} (bid ${quote.bid}, ask ${quote.ask})`);
  }
  if (status(order) !== "filled" && status(order) !== "closed") {
    await sleep(interval);
    order = await client.order(order.id);
  }
  return {
    status: status(order),
    quote,
    spreadRatio: check.ratio,
    prices,
    order,
    ...(spreadWidened ? { spreadWidened } : {}),
  };
}
