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
  openOrders(symbol?: string): Promise<OpenOrder[]>;
}

export type TradingClient = Pick<
  Broker,
  "quote" | "buyLimit" | "replace" | "order"
>;
