import type { Broker, Order, StockQuote } from "./broker.js";
import { current, finished } from "./ladder.js";
import { uncovered, type OpenSell } from "./safety.js";

// Stock orders from the site (user 2026-10-16): whole shares, long only, a
// limit order that starts at the mid and steps toward the ask (buy) or the
// bid (sell), and may fill in pre- and after-hours. There is no size check
// and no automatic stop. A sell can only close shares that are held and not
// already offered by another open sell.

export type StockSide = "buy" | "sell";

export const stockSteps = 4;
export const stockIntervalMs = 3000;

const tick = (price: number) => (price >= 1 ? 0.01 : 0.0001);
const toTick = (price: number, direction: "up" | "down") => {
  const t = tick(price);
  const n = price / t;
  // A hair of tolerance so 12.30000000001 does not round up a cent.
  const whole = direction === "up" ? Math.ceil(n - 1e-6) : Math.floor(n + 1e-6);
  return Number((whole * t).toFixed(t === 0.01 ? 2 : 4));
};

/**
 * Limit price of step `step` of `steps`: the mid at 0, the ask (buy) or the
 * bid (sell) at the last. Without both sides, the side that is there, else
 * the last trade, at every step. Null when there is no price at all.
 */
export function stockStepPrice(
  side: StockSide,
  quote: Pick<StockQuote, "bid" | "ask" | "last">,
  step: number,
  steps = stockSteps,
): number | null {
  const { bid, ask, last } = quote;
  if (bid !== null && ask !== null && ask >= bid) {
    const mid = (bid + ask) / 2;
    const share = steps > 0 ? Math.min(1, step / steps) : 1;
    return side === "buy"
      ? Math.min(ask, toTick(mid + (ask - mid) * share, "up"))
      : Math.max(bid, toTick(mid - (mid - bid) * share, "down"));
  }
  const one = side === "buy" ? (ask ?? last) : (bid ?? last);
  return one === null ? null : toTick(one, side === "buy" ? "up" : "down");
}

/** Whole shares a dollar amount buys at `price`. */
export function sharesFor(amount: number, price: number): number {
  return price > 0 ? Math.floor(amount / price + 1e-9) : 0;
}

/** Shares that may still be sold: held, less what open sells already offer. */
export function sellableShares(
  held: number,
  symbol: string,
  orders: OpenSell[],
): number {
  return held > 0 ? uncovered(held, symbol, orders) : 0;
}

/**
 * How many shares a sell request means: "all", "half" (rounded down, at
 * least one) or a whole number. Refuses anything beyond `sellable`.
 */
export function stockSellQty(asked: string, sellable: number): number {
  if (sellable <= 0) throw new Error("No shares are free to sell");
  const qty =
    asked === "all"
      ? sellable
      : asked === "half"
        ? Math.max(1, Math.floor(sellable / 2))
        : Number(asked);
  if (!Number.isInteger(qty) || qty < 1)
    throw new Error("qty must be all, half or a whole number of shares");
  if (qty > sellable)
    throw new Error(
      `Only ${sellable} share${sellable === 1 ? " is" : "s are"} free to sell; selling more would open a short position`,
    );
  return qty;
}

export type StockOrderStatus = "filled" | "partial" | "open" | "closed";

export interface StockOrderResult {
  status: StockOrderStatus;
  quote: StockQuote;
  prices: number[];
  order: Order;
  // The broker refused a price change; the order stays at its last price.
  raiseError?: string;
}

function status(order: Order): StockOrderStatus {
  if (order.status === "filled") return "filled";
  if (finished.has(order.status)) return "closed";
  return order.filledQty > 0 ? "partial" : "open";
}

type StockClient = Required<Pick<Broker, "stockQuote" | "stockLimit">> &
  Pick<Broker, "replace" | "order">;

/**
 * Sends a limit order at the mid and moves it every `intervalMs` toward the
 * ask or bid with a fresh quote. It never moves the price back. What has
 * not filled at the end is left working as a day order.
 */
export async function workStockOrder(
  client: StockClient,
  request: { symbol: string; side: StockSide; qty: number },
  options: {
    steps?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
    onOrder?: (order: Order) => void;
  } = {},
): Promise<StockOrderResult> {
  const steps = options.steps ?? stockSteps;
  const interval = options.intervalMs ?? stockIntervalMs;
  const sleep =
    options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = options.log ?? (() => {});
  const { symbol, side, qty } = request;
  let quote = await client.stockQuote(symbol);
  let price = stockStepPrice(side, quote, 0, steps);
  if (price === null) throw new Error(`No price for ${symbol} right now`);
  let order = await client.stockLimit(symbol, side, qty, price);
  options.onOrder?.(order);
  log(
    `${side} ${qty} ${symbol} @ ${price} (bid ${quote.bid}, ask ${quote.ask})`,
  );
  const prices = [price];
  let raiseError: string | undefined;
  for (let i = 1; i <= steps; i++) {
    await sleep(interval);
    order = await current(client, order.id);
    if (status(order) === "filled" || status(order) === "closed") break;
    quote = await client.stockQuote(symbol);
    const next = stockStepPrice(side, quote, i, steps);
    if (next === null) continue;
    const better = side === "buy" ? next > price + 1e-9 : next < price - 1e-9;
    if (!better) continue;
    try {
      order = await client.replace(order.id, next);
    } catch (error) {
      raiseError = error instanceof Error ? error.message : String(error);
      log(`could not move ${symbol} to ${next}: ${raiseError}`);
      break;
    }
    price = next;
    prices.push(price);
    log(`moved ${symbol} to ${price} (bid ${quote.bid}, ask ${quote.ask})`);
  }
  if (status(order) !== "filled" && status(order) !== "closed") {
    await sleep(interval);
    order = await current(client, order.id);
  }
  return {
    status: status(order),
    quote,
    prices,
    order,
    ...(raiseError === undefined ? {} : { raiseError }),
  };
}
