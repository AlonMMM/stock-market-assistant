import { roundToTick, type OptionQuote } from "./options.js";

// The option buy ticket's order (user 2026-10-18: "I'm missing the types of
// orders as well"). Alpaca takes market, limit, stop and stop limit for a
// single option, day or good till canceled
// (docs.alpaca.markets/docs/options-trading). Without a type the buy is the
// usual one: raised from the mid toward the ask. The automatic stop is a
// choice; without it nothing is placed on what fills.

export type OptionOrderType = "market" | "limit" | "stop" | "stop_limit";
export type OptionTimeInForce = "day" | "gtc";
export const optionOrderTypes: readonly OptionOrderType[] = [
  "market",
  "limit",
  "stop",
  "stop_limit",
];

export interface OptionTicketInput {
  orderType?: string;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce?: string;
  autoStop?: boolean;
}

export interface OptionTicket {
  // Absent: the stepped buy from the mid.
  type?: OptionOrderType;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce: OptionTimeInForce;
  noStop: boolean;
}

/** One order a broker can send for a buy that opens a long option. */
export interface OptionBuyOrder {
  type: OptionOrderType;
  timeInForce: OptionTimeInForce;
  limitPrice?: number;
  stopPrice?: number;
}

const onTick = (p: number) =>
  Number.isFinite(p) && p > 0 && roundToTick(p, "down") === p;

/** The ticket from a request; throws an Error naming the field to fix. */
export function optionTicket(input: OptionTicketInput): OptionTicket {
  const { limitPrice, stopPrice } = input;
  // A limit price alone is the plain limit buy, as before the types.
  const type =
    input.orderType ?? (limitPrice === undefined ? undefined : "limit");
  if (type !== undefined && !optionOrderTypes.includes(type as never))
    throw new Error(`orderType must be one of ${optionOrderTypes.join(", ")}`);
  const tif = input.timeInForce ?? "day";
  if (tif !== "day" && tif !== "gtc")
    throw new Error("timeInForce must be day or gtc");
  if (type === undefined && tif !== "day")
    throw new Error(
      "the stepped buy is a day order; choose limit for good till canceled",
    );
  const needsLimit = type === "limit" || type === "stop_limit";
  const needsStop = type === "stop" || type === "stop_limit";
  for (const [name, value, needed] of [
    ["limitPrice", limitPrice, needsLimit],
    ["stopPrice", stopPrice, needsStop],
  ] as const) {
    if (needed && value === undefined)
      throw new Error(`a ${type!.replace("_", " ")} order needs ${name}`);
    if (!needed && value !== undefined)
      throw new Error(
        `${name} is not used by ${type ? `a ${type.replace("_", " ")} order` : "the stepped buy"}`,
      );
    if (value !== undefined && !onTick(value))
      throw new Error(
        `${name} must be above 0, in steps of 0.01 below $3 and 0.05 from $3`,
      );
  }
  if (input.autoStop !== undefined && typeof input.autoStop !== "boolean")
    throw new Error("autoStop must be true or false");
  return {
    ...(type === undefined ? {} : { type: type as OptionOrderType }),
    ...(limitPrice === undefined ? {} : { limitPrice }),
    ...(stopPrice === undefined ? {} : { stopPrice }),
    timeInForce: tif,
    noStop: input.autoStop === false,
  };
}

/**
 * The most one contract is counted at for its size and checks: its own
 * limit; for a market buy the ask; for a stop buy the stop or the ask,
 * whichever is higher (it buys at the market once triggered).
 */
export function ticketCeiling(
  t: OptionTicket,
  quote: Pick<OptionQuote, "ask">,
  stepped: number,
): number {
  switch (t.type) {
    case undefined:
      return stepped;
    case "limit":
    case "stop_limit":
      return t.limitPrice!;
    case "market":
      return quote.ask;
    case "stop":
      return Math.max(t.stopPrice!, quote.ask);
  }
}

/** The broker order for a ticket with a type; null for the stepped buy. */
export function buyOrder(t: OptionTicket): OptionBuyOrder | null {
  if (!t.type) return null;
  return {
    type: t.type,
    timeInForce: t.timeInForce,
    ...(t.limitPrice === undefined ? {} : { limitPrice: t.limitPrice }),
    ...(t.stopPrice === undefined ? {} : { stopPrice: t.stopPrice }),
  };
}

/** "Stop limit 1.10 / 1.15 GTC", for logs and progress. */
export function describeTicket(t: OptionTicket): string {
  if (!t.type) return "stepped from the mid";
  const prices = [
    t.stopPrice === undefined ? "" : `stop ${t.stopPrice.toFixed(2)}`,
    t.limitPrice === undefined ? "" : `limit ${t.limitPrice.toFixed(2)}`,
  ].filter(Boolean);
  return [t.type.replace("_", " "), ...prices, t.timeInForce.toUpperCase()]
    .join(" ")
    .trim();
}
