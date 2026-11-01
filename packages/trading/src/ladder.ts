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
  // A forced buy: the spread is not checked, before sending or while raising;
  // a quote with no bid still stops it.
  anySpread?: boolean;
  // After the planned raises, keep raising to the current ask, every
  // `intervalMs`, for up to this long or until filled (the bot, user
  // 2026-10-23: "try to increase it until it filled"). The cap still holds;
  // the spread is not checked while chasing.
  chaseMs?: number;
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
  // Raises to the ask after the planned ones (chaseMs).
  chased?: number;
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
    // A forced buy lifts the spread limit only: an option with no bid is
    // never sent (user 2026-11-01, the bot buys at any spread).
    const noBid = !(quote.bid > 0);
    if (noBid || (!check.ok && !options.anySpread))
      return {
        status: "rejected-spread",
        quote,
        spreadRatio: check.ratio,
        prices: [],
      };
    price = Math.min(stepPrice(quote, 0, steps), cap);
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
    if (!(quote.bid > 0) || (!check.ok && !options.anySpread)) {
      spreadWidened = true;
      log(`spread ${(check.ratio * 100).toFixed(1)}% of mid; stopped raising`);
      break;
    }
    const next = Math.min(stepPrice(quote, i, steps), cap);
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
  // Chasing: the order follows the ask up, never down, until it fills, the
  // time is up, the cap is reached or the broker refuses a change.
  let chased = 0;
  const chaseMs = options.chaseMs ?? 0;
  for (
    let elapsed = 0;
    chaseMs > 0 &&
    raiseError === undefined &&
    elapsed < chaseMs &&
    status(order) !== "filled" &&
    status(order) !== "closed";
    elapsed += interval
  ) {
    await sleep(interval);
    order = await current(client, order.id);
    if (status(order) === "filled" || status(order) === "closed") break;
    quote = await client.quote(symbol);
    check = spreadCheck(quote);
    const next = Math.min(roundToTick(quote.ask, "down"), cap);
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
    chased++;
    log(
      `chasing: raised to ${price.toFixed(2)} (bid ${quote.bid}, ask ${quote.ask})`,
    );
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
    ...(chased > 0 ? { chased } : {}),
  };
}
