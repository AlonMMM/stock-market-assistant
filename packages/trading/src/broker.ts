import type { OptionBuyOrder } from "./option-tickets.js";
import type { OptionQuote, Right } from "./options.js";

// The trade flow talks to a broker only through this interface, so another
// broker is one more implementation (docs/tasks/backend-trading-service.md).
// Contracts are named by OCC symbol; an adapter translates if its broker
// uses another form.

export interface Order {
  id: string;
  symbol: string;
  status: string;
  qty: number;
  filledQty: number;
  filledAvgPrice: number | null;
  limitPrice: number | null;
  // The order that took this one's place when its price or size was changed.
  replacedBy?: string | null;
  // When the broker says it filled completely (ms); absent where it does not say.
  filledAt?: number;
}

/** One leg of a multi-leg order. */
export interface SpreadLeg {
  symbol: string;
  side: "buy" | "sell";
  intent: "buy_to_open" | "sell_to_open" | "buy_to_close" | "sell_to_close";
}

/**
 * A two-leg order filled as one unit (user 2026-10-17: debit spreads). The
 * limit is the net price per spread: positive is paid, negative received.
 */
export interface SpreadTicket {
  legs: [SpreadLeg, SpreadLeg];
  qty: number;
  limitPrice: number;
}

export interface OpenOrder extends Order {
  side: string;
  stopPrice: number | null;
  // A multi-leg order: its legs. Its own symbol and side are then empty.
  legs?: SpreadLeg[];
  // Set by brokers that report them; absent from older or simpler ones.
  type?: string; // market, limit, stop, stop_limit, trailing_stop
  timeInForce?: string;
  trailPercent?: number | null;
  trailPrice?: number | null;
  extendedHours?: boolean;
}

// Stock orders with every type a broker offers (user 2026-10-17). Long only:
// a sell can only close shares that are held (see stock-tickets.ts).
export type StockOrderType =
  "market" | "limit" | "stop" | "stop_limit" | "trailing_stop";
export type TimeInForce = "day" | "gtc" | "opg" | "cls" | "ioc" | "fok";

export interface StockTicket {
  symbol: string;
  side: "buy" | "sell";
  qty: number; // whole shares
  type: StockOrderType;
  timeInForce: TimeInForce;
  limitPrice?: number; // limit, stop_limit
  stopPrice?: number; // stop, stop_limit
  // trailing_stop: exactly one of the two.
  trailPercent?: number;
  trailPrice?: number;
  // May also fill in pre- and after-hours; limit orders with day or gtc only.
  extendedHours?: boolean;
}

/** What may change on an open order; Alpaca answers with a new order. */
export interface OrderChange {
  qty?: number;
  limitPrice?: number;
  stopPrice?: number;
  trail?: number; // trail_percent or trail_price, as the order has it
  timeInForce?: TimeInForce;
}

export interface Position {
  symbol: string;
  qty: number; // negative when short
  avgEntryPrice: number;
}

/** A stock's latest bid/ask and trade; a missing side is null. */
export interface StockQuote {
  symbol: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  quotedAt?: number; // ms
}

export interface Account {
  equity: number;
  lastEquity: number; // at the previous close
  buyingPower: number; // what a new option purchase may cost
}

export interface BrokerCapabilities {
  paper: boolean;
  // The broker itself refuses a sell that would open a short position.
  closeOnlyOrders: boolean;
  // Stop orders exist for single option contracts.
  optionStops: boolean;
  // An order's price is changed in place; otherwise by cancel and re-send.
  replaceInPlace: boolean;
  // False when the broker has no daily equity history of its own (IBKR), so
  // the trading service records the account's value each day and feeds it
  // back through `equityHistory` (apps/trader/src/equity-log.ts).
  ownEquityHistory?: boolean;
}

export interface Broker {
  readonly name: string;
  readonly capabilities: BrokerCapabilities;
  equity(): Promise<number>;
  account(): Promise<Account>;
  /** Whether options can trade right now. */
  marketOpen(): Promise<boolean>;
  /** Daily closing equity of the past year, oldest first. */
  equityHistory(): Promise<{ date: string; equity: number }[]>;
  /** Quotes and deltas for one side of the chain, expiries in [from, to]. */
  chain(
    underlying: string,
    right: Right,
    from: string,
    to: string,
  ): Promise<OptionQuote[]>;
  quote(symbol: string): Promise<OptionQuote>;
  /** Contracts traded per option over the 30 minutes up to `end` (ms). */
  optionVolume30?(symbols: string[], end: number): Promise<Map<string, number>>;
  /** Latest trade price of a stock; null when the broker has none. */
  stockPrice?(symbol: string): Promise<number | null>;
  /** A day limit buy that opens or adds to a long position. */
  buyLimit(symbol: string, qty: number, limitPrice: number): Promise<Order>;
  /**
   * A buy that opens or adds to a long option, of any type the broker takes
   * for options: market, limit, stop or stop limit, day or GTC.
   */
  optionBuy?(
    symbol: string,
    qty: number,
    order: OptionBuyOrder,
  ): Promise<Order>;
  /** A day limit sell that can only close contracts that are held. */
  sellLimit(symbol: string, qty: number, limitPrice: number): Promise<Order>;
  /** A good-till-canceled stop loss that can only close held contracts. */
  sellStop(symbol: string, qty: number, stop: number): Promise<Order>;
  replace(id: string, limitPrice: number): Promise<Order>;
  replaceStop(id: string, qty: number, stop: number): Promise<Order>;
  cancel(id: string): Promise<void>;
  order(id: string): Promise<Order>;
  position(symbol: string): Promise<{ qty: number; avgEntryPrice: number }>;
  /** Option positions only. */
  positions(): Promise<Position[]>;
  // Stocks (user 2026-10-16: bought and sold from the site, long only).
  /** Latest bid/ask of a stock, including pre/after-hours. */
  stockQuote?(symbol: string): Promise<StockQuote>;
  /**
   * A day limit order for whole shares that may also fill in pre/after-hours.
   * A sell can only close shares that are held.
   */
  stockLimit?(
    symbol: string,
    side: "buy" | "sell",
    qty: number,
    limitPrice: number,
  ): Promise<Order>;
  /** Stock positions only; a short one has a negative quantity. */
  stockPositions?(): Promise<Position[]>;
  /** A stock order of any type. A sell must only close shares that are held. */
  stockOrder?(ticket: StockTicket): Promise<Order>;
  /** Changes an open order's size, prices or time in force. */
  changeOrder?(id: string, change: OrderChange): Promise<Order>;
  /**
   * A day limit order for two option legs filled together. Absent on brokers
   * without multi-leg orders. Fills and price are the spread's, per unit.
   */
  spreadOrder?(ticket: SpreadTicket): Promise<Order>;
  openOrders(symbol?: string): Promise<OpenOrder[]>;
}

export type TradingClient = Pick<
  Broker,
  "quote" | "buyLimit" | "replace" | "order"
>;
