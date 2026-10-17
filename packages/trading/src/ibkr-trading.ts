import { coreClose, newYork } from "../../market-data/src/calendar.js";
import type {
  Account,
  Broker,
  BrokerCapabilities,
  OpenOrder,
  Order,
  Position,
  StockQuote,
} from "./broker.js";
import { parseOccSymbol, type OptionQuote, type Right } from "./options.js";

// Interactive Brokers through the owner's IB Gateway
// (docs/features/multi-user-ibkr.md, phase 3). The trade flow speaks OCC
// symbols and Alpaca's order words; this adapter translates both ways.
//
// It talks to the Gateway only through `TwsClient`, a small promise-based
// view of the TWS API. The real client wraps @stoqey/ib; tests use a fake.
//
// IBKR does not refuse a sell that would open a short position, so every
// sell here checks first that it only closes what is held and not already
// offered by another open sell (the never-short rule, 2026-10-10).

export interface IbContract {
  conId?: number;
  symbol: string;
  secType: "OPT" | "STK";
  // Options only: expiry as YYYYMMDD, strike, right and the multiplier.
  lastTradeDateOrContractMonth?: string;
  strike?: number;
  right?: "C" | "P";
  multiplier?: string;
  exchange: string;
  currency: string;
}

export interface IbOrderRequest {
  action: "BUY" | "SELL";
  totalQuantity: number;
  orderType: "LMT" | "STP";
  lmtPrice?: number;
  auxPrice?: number; // the stop price
  tif: "DAY" | "GTC";
  outsideRth?: boolean;
}

/** An order the Gateway knows of this session, open or done. */
export interface IbOrderState {
  orderId: number;
  contract: IbContract;
  action: "BUY" | "SELL";
  totalQuantity: number;
  orderType: string;
  lmtPrice: number | null;
  auxPrice: number | null;
  tif: "DAY" | "GTC";
  outsideRth?: boolean;
  status: string; // TWS words: Submitted, Filled, Cancelled, …
  filled: number;
  avgFillPrice: number;
}

export interface IbPosition {
  contract: IbContract;
  position: number; // negative when short
  avgCost: number; // per contract × multiplier for options, per share for stocks
}

export interface IbSnapshot {
  bid: number | null;
  ask: number | null;
  last: number | null;
  delta: number | null; // options: model delta
  at: number | null; // ms
}

export interface TwsClient {
  /** Contracts matching a partial one, each with its conId. */
  contracts(contract: IbContract): Promise<IbContract[]>;
  /** Expiries (YYYYMMDD) and strikes listed for an underlying. */
  optionParams(
    symbol: string,
    conId: number,
  ): Promise<{ expirations: string[]; strikes: number[] }>;
  snapshot(contract: IbContract): Promise<IbSnapshot>;
  /** Sends an order; with `id`, changes that order in place. Returns its id. */
  placeOrder(
    contract: IbContract,
    order: IbOrderRequest,
    id?: number,
  ): Promise<number>;
  cancelOrder(id: number): Promise<void>;
  orders(): Promise<IbOrderState[]>;
  positions(): Promise<IbPosition[]>;
  /** Account summary values by tag, such as NetLiquidation. */
  accountValues(): Promise<Record<string, number>>;
}

export interface IbkrOptions {
  paper: boolean;
  now?: () => number;
  // Daily closing equity, kept by the service; TWS has no such history.
  history?: () => Promise<{ date: string; equity: number }[]>;
  // Option snapshots asked at once while building a chain.
  concurrency?: number;
}

const usd = { exchange: "SMART", currency: "USD" };

/** The OCC symbol of an option contract. */
export function occSymbol(c: IbContract): string {
  if (
    c.secType !== "OPT" ||
    !c.lastTradeDateOrContractMonth ||
    c.strike === undefined ||
    !c.right
  )
    throw new Error(`Not an option contract: ${c.symbol}`);
  const strike = String(Math.round(c.strike * 1000)).padStart(8, "0");
  return `${c.symbol}${c.lastTradeDateOrContractMonth.slice(2, 8)}${c.right}${strike}`;
}

/** The IBKR contract of an OCC symbol, before its conId is known. */
export function optionContract(symbol: string): IbContract {
  const o = parseOccSymbol(symbol);
  return {
    symbol: o.underlying,
    secType: "OPT",
    lastTradeDateOrContractMonth: o.expiry.replaceAll("-", ""),
    strike: o.strike,
    right: o.right === "call" ? "C" : "P",
    multiplier: "100",
    ...usd,
  };
}

const stockContract = (symbol: string): IbContract => ({
  symbol,
  secType: "STK",
  ...usd,
});

const nameOf = (c: IbContract) =>
  c.secType === "OPT" ? occSymbol(c) : c.symbol;

/** TWS order status in the words the trade flow uses (Alpaca's). */
export function orderStatus(status: string, filled: number): string {
  switch (status) {
    case "Filled":
      return "filled";
    case "Cancelled":
    case "ApiCancelled":
      return "canceled";
    case "Inactive":
      return "rejected";
    default:
      return filled > 0 ? "partially_filled" : "new";
  }
}
const done = new Set(["filled", "canceled", "rejected"]);

const toOrder = (o: IbOrderState): OpenOrder => {
  const status = orderStatus(o.status, o.filled);
  return {
    id: String(o.orderId),
    symbol: nameOf(o.contract),
    status,
    qty: o.totalQuantity,
    filledQty: o.filled,
    filledAvgPrice: o.filled > 0 ? o.avgFillPrice : null,
    limitPrice: o.orderType === "LMT" ? o.lmtPrice : null,
    side: o.action === "BUY" ? "buy" : "sell",
    stopPrice: o.orderType === "STP" ? o.auxPrice : null,
  };
};

const positive = (v: number | null) =>
  v !== null && Number.isFinite(v) && v > 0 ? v : null;
const cents = (p: number) => Math.round(p * 100) / 100;
const stockPrice = (p: number) =>
  p >= 1 ? cents(p) : Math.round(p * 10000) / 10000;
const ymd = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

async function inBatches<T, R>(
  items: T[],
  size: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map(work))));
  return out;
}

// Strikes asked for a chain, as a share of the stock price on the side the
// trade flow buys (out of the money): delta 0.10–0.15 sits well inside it.
const chainReach = 0.3;
const chainStrikes = 30;

export class IbkrTrading implements Broker {
  readonly name = "ibkr";
  private readonly conIds = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly client: TwsClient,
    private readonly options: IbkrOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  get capabilities(): BrokerCapabilities {
    return {
      paper: this.options.paper,
      // IBKR opens a short on such a sell; the check is ours (closeOnly).
      closeOnlyOrders: false,
      optionStops: true,
      replaceInPlace: true,
    };
  }

  /** The contract with its conId, looked up once. */
  private async resolve(contract: IbContract): Promise<IbContract> {
    const key = nameOf(contract);
    const known = this.conIds.get(key);
    if (known !== undefined) return { ...contract, conId: known };
    const [found] = await this.client.contracts(contract);
    if (!found?.conId) throw new Error(`IBKR has no contract ${key}`);
    this.conIds.set(key, found.conId);
    return { ...contract, conId: found.conId };
  }

  async equity() {
    return (await this.account()).equity;
  }

  async account(): Promise<Account> {
    const v = await this.client.accountValues();
    const equity = v.NetLiquidation ?? 0;
    return {
      equity,
      lastEquity: v.PreviousDayEquityWithLoanValue ?? equity,
      // Options are paid in cash: what is free to spend, not margin power.
      buyingPower: v.AvailableFunds ?? 0,
    };
  }

  async marketOpen() {
    const { date, minute } = newYork(this.now());
    const close = coreClose(date);
    return close !== null && minute >= 570 && minute < close;
  }

  async equityHistory() {
    return this.options.history ? this.options.history() : [];
  }

  async chain(
    underlying: string,
    right: Right,
    from: string,
    to: string,
  ): Promise<OptionQuote[]> {
    const stock = await this.resolve(stockContract(underlying));
    const tick = await this.client.snapshot(stock);
    const spot =
      positive(tick.last) ??
      (positive(tick.bid) && positive(tick.ask)
        ? (tick.bid! + tick.ask!) / 2
        : null);
    if (spot === null) throw new Error(`No price for ${underlying}`);
    const params = await this.client.optionParams(underlying, stock.conId!);
    const expiries = params.expirations
      .map(ymd)
      .filter((d) => d >= from && d <= to)
      .sort();
    const strikes = params.strikes
      .filter((s) =>
        right === "call"
          ? s >= spot * 0.98 && s <= spot * (1 + chainReach)
          : s <= spot * 1.02 && s >= spot * (1 - chainReach),
      )
      .sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))
      .slice(0, chainStrikes);
    const wanted = expiries.flatMap((expiry) =>
      strikes.map((strike) =>
        optionContract(
          occSymbol({
            symbol: underlying,
            secType: "OPT",
            lastTradeDateOrContractMonth: expiry.replaceAll("-", ""),
            strike,
            right: right === "call" ? "C" : "P",
            ...usd,
          }),
        ),
      ),
    );
    // A strike listed for some expiries only is missing from the others.
    const quotes = await inBatches(wanted, this.options.concurrency ?? 8, (c) =>
      this.optionQuote(c).catch(() => null),
    );
    return quotes.filter((q): q is OptionQuote => q !== null);
  }

  private async optionQuote(contract: IbContract): Promise<OptionQuote> {
    const resolved = await this.resolve(contract);
    const s = await this.client.snapshot(resolved);
    const symbol = occSymbol(contract);
    return {
      symbol,
      ...parseOccSymbol(symbol),
      bid: positive(s.bid) ?? 0,
      ask: positive(s.ask) ?? 0,
      delta: s.delta !== null && Number.isFinite(s.delta) ? s.delta : null,
      ...(s.at !== null ? { quotedAt: s.at } : {}),
    };
  }

  quote(symbol: string) {
    return this.optionQuote(optionContract(symbol));
  }

  private async state(id: string): Promise<IbOrderState> {
    const found = (await this.client.orders()).find(
      (o) => String(o.orderId) === id,
    );
    if (!found) throw new Error(`IBKR has no order ${id}`);
    return found;
  }

  private async place(contract: IbContract, order: IbOrderRequest) {
    const id = await this.client.placeOrder(
      await this.resolve(contract),
      order,
    );
    return this.order(String(id));
  }

  /**
   * Refuses a sell of `qty` that would sell more than is held, counting
   * what other open sells already offer. `except` is the order being changed.
   */
  private async closeOnly(symbol: string, qty: number, except?: string) {
    const [held, orders] = await Promise.all([
      this.client.positions(),
      this.client.orders(),
    ]);
    const have = held
      .filter((p) => nameOf(p.contract) === symbol)
      .reduce((sum, p) => sum + p.position, 0);
    const offered = orders
      .filter(
        (o) =>
          nameOf(o.contract) === symbol &&
          o.action === "SELL" &&
          String(o.orderId) !== except &&
          !done.has(orderStatus(o.status, o.filled)),
      )
      .reduce((sum, o) => sum + (o.totalQuantity - o.filled), 0);
    if (qty > have - offered)
      throw new Error(
        `Refused: selling ${qty} ${symbol} could open a short position (${Math.max(have, 0)} held, ${offered} already offered by open sells)`,
      );
  }

  buyLimit(symbol: string, qty: number, limitPrice: number) {
    return this.place(optionContract(symbol), {
      action: "BUY",
      totalQuantity: qty,
      orderType: "LMT",
      lmtPrice: cents(limitPrice),
      tif: "DAY",
    });
  }

  async sellLimit(symbol: string, qty: number, limitPrice: number) {
    await this.closeOnly(symbol, qty);
    return this.place(optionContract(symbol), {
      action: "SELL",
      totalQuantity: qty,
      orderType: "LMT",
      lmtPrice: cents(limitPrice),
      tif: "DAY",
    });
  }

  async sellStop(symbol: string, qty: number, stop: number) {
    await this.closeOnly(symbol, qty);
    return this.place(optionContract(symbol), {
      action: "SELL",
      totalQuantity: qty,
      orderType: "STP",
      auxPrice: cents(stop),
      tif: "GTC",
    });
  }

  async replace(id: string, limitPrice: number) {
    const o = await this.state(id);
    const price =
      o.contract.secType === "STK" ? stockPrice(limitPrice) : cents(limitPrice);
    await this.client.placeOrder(
      o.contract,
      request(o, { lmtPrice: price }),
      o.orderId,
    );
    return this.order(id);
  }

  async replaceStop(id: string, qty: number, stop: number) {
    const o = await this.state(id);
    if (o.action === "SELL") await this.closeOnly(nameOf(o.contract), qty, id);
    await this.client.placeOrder(
      o.contract,
      request(o, { totalQuantity: qty, auxPrice: cents(stop) }),
      o.orderId,
    );
    return this.order(id);
  }

  async cancel(id: string) {
    await this.client.cancelOrder(Number(id));
  }

  async order(id: string): Promise<Order> {
    const {
      side: _side,
      stopPrice: _stop,
      ...order
    } = toOrder(await this.state(id));
    return order;
  }

  async position(symbol: string) {
    const p = (await this.client.positions()).find(
      (x) => nameOf(x.contract) === symbol && x.position !== 0,
    );
    // Like Alpaca's 404: callers treat it as nothing held.
    if (!p) throw new Error(`No position in ${symbol}`);
    return { qty: p.position, avgEntryPrice: entryPrice(p) };
  }

  async positions(): Promise<Position[]> {
    return (await this.client.positions())
      .filter((p) => p.contract.secType === "OPT" && p.position !== 0)
      .map((p) => ({
        symbol: occSymbol(p.contract),
        qty: p.position,
        avgEntryPrice: entryPrice(p),
      }));
  }

  async openOrders(symbol?: string): Promise<OpenOrder[]> {
    return (await this.client.orders())
      .map(toOrder)
      .filter((o) => !done.has(o.status) && (!symbol || o.symbol === symbol));
  }

  async stockQuote(symbol: string): Promise<StockQuote> {
    const s = await this.client.snapshot(
      await this.resolve(stockContract(symbol)),
    );
    return {
      symbol,
      bid: positive(s.bid),
      ask: positive(s.ask),
      last: positive(s.last),
      ...(s.at !== null ? { quotedAt: s.at } : {}),
    };
  }

  async stockLimit(
    symbol: string,
    side: "buy" | "sell",
    qty: number,
    limitPrice: number,
  ) {
    if (side === "sell") await this.closeOnly(symbol, qty);
    return this.place(stockContract(symbol), {
      action: side === "buy" ? "BUY" : "SELL",
      totalQuantity: qty,
      orderType: "LMT",
      lmtPrice: stockPrice(limitPrice),
      tif: "DAY",
      // May also fill in pre- and after-hours, as on Alpaca.
      outsideRth: true,
    });
  }

  async stockPositions(): Promise<Position[]> {
    return (await this.client.positions())
      .filter((p) => p.contract.secType === "STK" && p.position !== 0)
      .map((p) => ({
        symbol: p.contract.symbol,
        qty: p.position,
        avgEntryPrice: p.avgCost,
      }));
  }
}

/** IBKR's average cost of an option includes the multiplier. */
function entryPrice(p: IbPosition) {
  return p.contract.secType === "OPT"
    ? p.avgCost / Number(p.contract.multiplier ?? 100)
    : p.avgCost;
}

/** The same order with some fields changed, to send under its own id. */
function request(
  o: IbOrderState,
  change: Partial<IbOrderRequest>,
): IbOrderRequest {
  return {
    action: o.action,
    totalQuantity: o.totalQuantity,
    orderType: o.orderType === "STP" ? "STP" : "LMT",
    ...(o.lmtPrice !== null ? { lmtPrice: o.lmtPrice } : {}),
    ...(o.auxPrice !== null ? { auxPrice: o.auxPrice } : {}),
    tif: o.tif,
    ...(o.outsideRth ? { outsideRth: true } : {}),
    ...change,
  };
}
