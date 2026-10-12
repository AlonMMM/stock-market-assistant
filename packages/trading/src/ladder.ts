import type { Order, TradingClient } from "./broker.js";
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
  // An order already at the broker (sent while the market was closed): it is
  // raised from its own price, and no new order is sent.
  existing?: Order;
  // Bid the ask from the first order on, and follow it up, instead of
  // starting at the mid (user 2026-10-12: a paper account fills at the ask).
  atAsk?: boolean;
  // A forced buy: the spread is not checked, before sending or while raising.
  anySpread?: boolean;
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
  // Raising stopped early because the broker refused a price change (for
  // example while the market is closed); the order stays at its last price.
  raiseError?: string;
}

// Order states in which nothing more can fill.
export const finished = new Set([
  "filled",
  "canceled",
  "expired",
  "rejected",
  "done_for_day",
]);

/**
 * The order's present state. An order whose price was changed from outside
 * (the site's "change price") lives on under a new id: that one is returned.
 */
export async function current(
  client: Pick<TradingClient, "order">,
  id: string,
): Promise<Order> {
  let order = await client.order(id);
  for (let hops = 0; order.replacedBy && hops < 20; hops++)
    order = await client.order(order.replacedBy);
  return order;
}

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
  let order: Order;
  let price: number;
  if (options.existing) {
    order = options.existing;
    price = order.limitPrice ?? Math.min(stepPrice(quote, 0, steps), cap);
    log(
      `working the waiting order @ ${price.toFixed(2)} (bid ${quote.bid}, ask ${quote.ask})`,
    );
  } else {
    if (!check.ok && !options.anySpread)
      return {
        status: "rejected-spread",
        quote,
        spreadRatio: check.ratio,
        prices: [],
      };
    price = Math.min(
      options.atAsk ? quote.ask : stepPrice(quote, 0, steps),
      cap,
    );
    if (!(price > 0) || price < roundToTick(check.mid, "down") - 1e-9)
      return {
        status: "rejected-budget",
        quote,
        spreadRatio: check.ratio,
        prices: [],
      };
    order = await client.buyLimit(symbol, qty, price);
    log(
      `sent ${qty} @ ${price.toFixed(2)} (bid ${quote.bid}, ask ${quote.ask})`,
    );
  }
  const prices = [price];
  let spreadWidened = false;
  let raiseError: string | undefined;

  for (let i = 1; i <= steps; i++) {
    await sleep(interval);
    order = await current(client, order.id);
    if (status(order) === "filled" || status(order) === "closed") break;
    quote = await client.quote(symbol);
    check = spreadCheck(quote);
    if (!check.ok && !options.anySpread) {
      spreadWidened = true;
      log(`spread ${(check.ratio * 100).toFixed(1)}% of mid; stopped raising`);
      break;
    }
    const next = Math.min(
      options.atAsk ? quote.ask : stepPrice(quote, i, steps),
      cap,
    );
    if (next <= price + 1e-9) continue;
    try {
      order = await client.replace(order.id, next);
    } catch (error) {
      raiseError = error instanceof Error ? error.message : String(error);
      log(`could not raise to ${next.toFixed(2)}: ${raiseError}`);
      break;
    }
    price = next;
    prices.push(price);
    log(`raised to ${price.toFixed(2)} (bid ${quote.bid}, ask ${quote.ask})`);
  }
  if (status(order) !== "filled" && status(order) !== "closed") {
    await sleep(interval);
    order = await current(client, order.id);
  }
  return {
    status: status(order),
    quote,
    spreadRatio: check.ratio,
    prices,
    order,
    ...(spreadWidened ? { spreadWidened } : {}),
    ...(raiseError === undefined ? {} : { raiseError }),
  };
}
