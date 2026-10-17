import type {
  OpenOrder,
  OrderChange,
  StockOrderType,
  StockQuote,
  StockTicket,
  TimeInForce,
} from "./broker.js";
import { sellableShares, sharesFor } from "./stock-orders.js";

// The stock order ticket (user 2026-10-17: "all the options a real broker
// gives"): market, limit, stop, stop limit and trailing stop, each time in
// force, extended hours, buy and sell. The rules here are Alpaca's for
// equities (docs/tasks/backend-stock-order-types.md), checked before anything
// is sent so a refusal names the field to fix. Long only: a sell may only
// close shares held and not already offered by another open sell.

export const stockOrderTypes: readonly StockOrderType[] = [
  "market",
  "limit",
  "stop",
  "stop_limit",
  "trailing_stop",
];
export const timesInForce: readonly TimeInForce[] = [
  "day",
  "gtc",
  "opg",
  "cls",
  "ioc",
  "fok",
];

/** Which time in force each type accepts. */
export const allowedTimeInForce: Record<StockOrderType, TimeInForce[]> = {
  market: ["day", "gtc", "opg", "cls", "ioc", "fok"],
  limit: ["day", "gtc", "opg", "cls", "ioc", "fok"],
  stop: ["day", "gtc"],
  stop_limit: ["day", "gtc"],
  trailing_stop: ["day", "gtc"],
};

/** A ticket the caller must fix; nothing was sent. */
export class TicketError extends Error {
  constructor(
    readonly field: string,
    detail: string,
  ) {
    super(`${field}: ${detail}`);
  }
}

// Cents from $1; below $1, 1/100 of a cent.
const onTick = (price: number) => {
  const step = price >= 1 ? 100 : 10000;
  return Math.abs(price * step - Math.round(price * step)) < 1e-6;
};

type Input = Record<string, unknown>;

function price(input: Input, name: string): number | undefined {
  const v = input[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || !(v > 0))
    throw new TicketError(name, "must be a price above zero");
  if (!onTick(v))
    throw new TicketError(
      name,
      `${v} is not a valid price: whole cents from $1, 1/100 of a cent below`,
    );
  return v;
}

export interface TicketContext {
  quote: Pick<StockQuote, "bid" | "ask" | "last">;
  held: number; // shares held, 0 when none
  open: OpenOrder[]; // this symbol's open orders
  marketOpen: boolean | null;
}

export interface CheckedTicket {
  ticket: StockTicket;
  sellable: number; // before this order
  // The price a share is counted at for `amount` and the estimate.
  priceBasis: number | null;
  estimatedCost: number | null;
  // Worth knowing, does not stop the order.
  notes: string[];
}

/**
 * Turns the request into a ticket the broker accepts, or throws TicketError.
 * `qty` is shares (`all` and `half` too for a sell); `amount` is dollars, for
 * a buy, turned into whole shares at the order's own price (else the ask).
 */
export function stockTicket(
  symbol: string,
  input: Input,
  c: TicketContext,
): CheckedTicket {
  const side = input.side;
  if (side !== "buy" && side !== "sell")
    throw new TicketError("side", "must be buy or sell");
  const type = input.type as StockOrderType;
  if (!stockOrderTypes.includes(type))
    throw new TicketError(
      "type",
      `must be one of ${stockOrderTypes.join(", ")}`,
    );
  const timeInForce = (input.timeInForce ?? "day") as TimeInForce;
  if (!timesInForce.includes(timeInForce))
    throw new TicketError(
      "timeInForce",
      `must be one of ${timesInForce.join(", ")}`,
    );
  if (!allowedTimeInForce[type].includes(timeInForce))
    throw new TicketError(
      "timeInForce",
      `${timeInForce} is not offered for a ${type.replace("_", " ")} order; use ${allowedTimeInForce[type].join(" or ")}`,
    );

  const limitPrice = price(input, "limitPrice");
  const stopPrice = price(input, "stopPrice");
  const trailPrice = price(input, "trailPrice");
  const trailPercentIn = input.trailPercent;
  let trailPercent: number | undefined;
  if (trailPercentIn !== undefined && trailPercentIn !== null) {
    if (
      typeof trailPercentIn !== "number" ||
      !Number.isFinite(trailPercentIn) ||
      !(trailPercentIn > 0 && trailPercentIn < 100)
    )
      throw new TicketError("trailPercent", "must be between 0 and 100");
    trailPercent = trailPercentIn;
  }
  const needs = {
    limitPrice: type === "limit" || type === "stop_limit",
    stopPrice: type === "stop" || type === "stop_limit",
    trail: type === "trailing_stop",
  };
  if (needs.limitPrice !== (limitPrice !== undefined))
    throw new TicketError(
      "limitPrice",
      needs.limitPrice
        ? `a ${type.replace("_", " ")} order needs one`
        : `a ${type.replace("_", " ")} order has none`,
    );
  if (needs.stopPrice !== (stopPrice !== undefined))
    throw new TicketError(
      "stopPrice",
      needs.stopPrice
        ? `a ${type.replace("_", " ")} order needs one`
        : `a ${type.replace("_", " ")} order has none`,
    );
  const trails =
    (trailPrice !== undefined ? 1 : 0) + (trailPercent !== undefined ? 1 : 0);
  if (needs.trail ? trails !== 1 : trails !== 0)
    throw new TicketError(
      "trail",
      needs.trail
        ? "a trailing stop needs trailPercent or trailPrice, not both"
        : "only a trailing stop has a trail",
    );

  const extended = input.extendedHours;
  if (extended !== undefined && typeof extended !== "boolean")
    throw new TicketError("extendedHours", "must be true or false");
  if (
    extended === true &&
    !(type === "limit" && (timeInForce === "day" || timeInForce === "gtc"))
  )
    throw new TicketError(
      "extendedHours",
      "only a limit order with day or gtc may fill in pre- and after-hours",
    );

  const { bid, ask, last } = c.quote;
  // What one share is counted at: the order's own price where it has one.
  const priceBasis =
    type === "limit" || type === "stop_limit"
      ? limitPrice!
      : side === "buy"
        ? type === "stop"
          ? Math.max(stopPrice!, ask ?? last ?? 0) || null
          : (ask ?? last)
        : type === "stop"
          ? stopPrice!
          : (bid ?? last);

  const sellable = sellableShares(c.held, symbol, c.open);
  let qty: number;
  const qtyIn = input.qty;
  const amount = input.amount;
  if (side === "sell") {
    if (amount !== undefined)
      throw new TicketError("amount", "a sell is sized in shares");
    if (sellable <= 0)
      throw new TicketError(
        "qty",
        c.held > 0
          ? `all ${c.held} ${symbol} shares are already offered by open sell orders`
          : `no ${symbol} shares are held; a sale would open a short position`,
      );
    qty =
      qtyIn === "all"
        ? sellable
        : qtyIn === "half"
          ? Math.max(1, Math.floor(sellable / 2))
          : (qtyIn as number);
    if (!Number.isInteger(qty) || qty < 1)
      throw new TicketError(
        "qty",
        "must be all, half or a whole number of shares",
      );
    if (qty > sellable)
      throw new TicketError(
        "qty",
        `only ${sellable} share${sellable === 1 ? " is" : "s are"} free to sell; selling more would open a short position`,
      );
  } else if ((qtyIn === undefined) === (amount === undefined)) {
    throw new TicketError("qty", "give qty (shares) or amount (dollars)");
  } else if (qtyIn !== undefined) {
    qty = qtyIn as number;
    if (!Number.isInteger(qty) || qty < 1)
      throw new TicketError("qty", "must be a whole number of shares");
  } else {
    if (typeof amount !== "number" || !Number.isFinite(amount) || !(amount > 0))
      throw new TicketError("amount", "must be dollars above zero");
    if (priceBasis === null)
      throw new TicketError("amount", `no price for ${symbol} to size it at`);
    qty = sharesFor(amount, priceBasis);
    if (qty < 1)
      throw new TicketError(
        "amount",
        `$${amount} does not buy one share of ${symbol} at ${priceBasis}`,
      );
  }

  const notes: string[] = [];
  const ref = side === "buy" ? (ask ?? last) : (bid ?? last);
  if (ref !== null) {
    if (type === "stop" || type === "stop_limit") {
      const now = side === "buy" ? stopPrice! <= ref : stopPrice! >= ref;
      if (now)
        notes.push(
          `the stop ${stopPrice} is already ${side === "buy" ? "at or below the ask" : "at or above the bid"} (${ref}); it triggers at once`,
        );
    }
    if (
      type === "limit" &&
      (side === "buy" ? limitPrice! >= ref : limitPrice! <= ref)
    )
      notes.push(
        `the limit ${limitPrice} is ${side === "buy" ? "at or above the ask" : "at or below the bid"} (${ref}); it can fill at once`,
      );
  }
  if (type === "stop_limit") {
    const gap =
      side === "buy" ? limitPrice! < stopPrice! : limitPrice! > stopPrice!;
    if (gap)
      notes.push(
        `the limit ${limitPrice} is ${side === "buy" ? "below" : "above"} the stop ${stopPrice}; once triggered it may not fill`,
      );
  }
  if (
    c.marketOpen === false &&
    !extended &&
    (timeInForce === "day" || timeInForce === "gtc")
  )
    notes.push("the market is closed; the order waits for the regular session");
  if (timeInForce === "ioc" || timeInForce === "fok")
    notes.push(
      timeInForce === "ioc"
        ? "immediate or cancel: what does not fill at once is canceled"
        : "fill or kill: it fills in full at once or is canceled",
    );

  const ticket: StockTicket = {
    symbol,
    side,
    qty,
    type,
    timeInForce,
    ...(limitPrice === undefined ? {} : { limitPrice }),
    ...(stopPrice === undefined ? {} : { stopPrice }),
    ...(trailPercent === undefined ? {} : { trailPercent }),
    ...(trailPrice === undefined ? {} : { trailPrice }),
    ...(extended ? { extendedHours: true } : {}),
  };
  return {
    ticket,
    sellable,
    priceBasis,
    estimatedCost:
      priceBasis === null ? null : Number((priceBasis * qty).toFixed(2)),
    notes,
  };
}

/**
 * The change asked for an open stock order, checked against its type. A sell
 * may grow only into shares that no other open sell offers.
 */
export function stockChange(
  order: OpenOrder,
  input: Input,
  c: { held: number; open: OpenOrder[] },
): OrderChange {
  const type = (order.type ??
    (order.stopPrice === null ? "limit" : "stop")) as StockOrderType;
  const change: OrderChange = {};
  const qty = input.qty;
  if (qty !== undefined) {
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1)
      throw new TicketError("qty", "must be a whole number of shares");
    if (qty < order.filledQty + 1)
      throw new TicketError(
        "qty",
        `${order.filledQty} already filled; the order must stay above that`,
      );
    if (order.side === "sell") {
      // Shares free besides what this order already offers.
      const others = c.open.filter((o) => o.id !== order.id);
      const free = sellableShares(c.held, order.symbol, others);
      if (qty - order.filledQty > free)
        throw new TicketError(
          "qty",
          `only ${free} share${free === 1 ? " is" : "s are"} free for this sale; more would open a short position`,
        );
    }
    change.qty = qty;
  }
  const limitPrice = price(input, "limitPrice");
  const stopPrice = price(input, "stopPrice");
  if (limitPrice !== undefined) {
    if (type !== "limit" && type !== "stop_limit")
      throw new TicketError(
        "limitPrice",
        `a ${type.replace("_", " ")} order has none`,
      );
    change.limitPrice = limitPrice;
  }
  if (stopPrice !== undefined) {
    if (type !== "stop" && type !== "stop_limit")
      throw new TicketError(
        "stopPrice",
        `a ${type.replace("_", " ")} order has none`,
      );
    change.stopPrice = stopPrice;
  }
  const trail = input.trail;
  if (trail !== undefined) {
    if (type !== "trailing_stop")
      throw new TicketError("trail", "only a trailing stop has a trail");
    if (typeof trail !== "number" || !Number.isFinite(trail) || !(trail > 0))
      throw new TicketError("trail", "must be above zero");
    change.trail = trail;
  }
  const tif = input.timeInForce;
  if (tif !== undefined) {
    if (
      !timesInForce.includes(tif as TimeInForce) ||
      !allowedTimeInForce[type].includes(tif as TimeInForce)
    )
      throw new TicketError(
        "timeInForce",
        `use ${allowedTimeInForce[type].join(" or ")} for a ${type.replace("_", " ")} order`,
      );
    if (order.extendedHours && tif !== "day" && tif !== "gtc")
      throw new TicketError(
        "timeInForce",
        "an extended-hours order uses day or gtc",
      );
    change.timeInForce = tif as TimeInForce;
  }
  if (Object.keys(change).length === 0)
    throw new TicketError("change", "nothing to change");
  return change;
}
