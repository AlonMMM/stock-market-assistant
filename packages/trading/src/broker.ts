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
}

export interface OpenOrder extends Order {
  side: string;
  stopPrice: number | null;
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
  /** Latest trade price of a stock; null when the broker has none. */
  stockPrice?(symbol: string): Promise<number | null>;
  /** A day limit buy that opens or adds to a long position. */
  buyLimit(symbol: string, qty: number, limitPrice: number): Promise<Order>;
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
  openOrders(symbol?: string): Promise<OpenOrder[]>;
}

export type TradingClient = Pick<
  Broker,
  "quote" | "buyLimit" | "replace" | "order"
>;
