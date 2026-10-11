import type {
  Broker,
  BrokerCapabilities,
  OpenOrder,
  Order,
  Position,
} from "./broker.js";
import { parseOccSymbol, type OptionQuote } from "./options.js";

// A broker that exists only in memory, for tests and practice runs. It fills
// a buy at its limit once the limit reaches the ask (or `fillAt`), fills a
// sell at its limit once the limit is at or below the bid, and, like Alpaca,
// refuses a sell for more contracts than are free.

interface SimOrder extends OpenOrder {
  kind: "buy" | "sell" | "stop";
}

export class SimBroker implements Broker {
  readonly name = "sim";
  readonly capabilities: BrokerCapabilities = {
    paper: true,
    closeOnlyOrders: true,
    optionStops: true,
    replaceInPlace: true,
  };
  cash: number;
  /** Buy limit at which a buy fills; the ask when not set. */
  fillAt = new Map<string, number>();
  readonly orders = new Map<string, SimOrder>();
  private held = new Map<string, { qty: number; cost: number }>();
  private quotes = new Map<string, OptionQuote>();
  private nextId = 1;

  constructor(equity = 100_000) {
    this.cash = equity;
  }

  /** Sets or moves a contract's quote. */
  setQuote(symbol: string, bid: number, ask: number, delta: number | null) {
    this.quotes.set(symbol, {
      symbol,
      ...parseOccSymbol(symbol),
      bid,
      ask,
      delta,
    });
    for (const o of this.orders.values()) this.settle(o);
  }

  private open(o: SimOrder) {
    return o.status === "new" || o.status === "partially_filled";
  }

  private fill(o: SimOrder, price: number) {
    const qty = o.qty - o.filledQty;
    const h = this.held.get(o.symbol) ?? { qty: 0, cost: 0 };
    if (o.kind === "buy") {
      this.held.set(o.symbol, {
        qty: h.qty + qty,
        cost: h.cost + qty * price,
      });
      this.cash -= qty * price * 100;
    } else {
      const left = h.qty - qty;
      if (left === 0) this.held.delete(o.symbol);
      else
        this.held.set(o.symbol, {
          qty: left,
          cost: (h.cost / h.qty) * left,
        });
      this.cash += qty * price * 100;
    }
    o.filledQty = o.qty;
    o.filledAvgPrice = price;
    o.status = "filled";
  }

  private settle(o: SimOrder) {
    if (!this.open(o)) return;
    const q = this.quotes.get(o.symbol);
    if (!q) return;
    if (o.kind === "buy") {
      const at = this.fillAt.get(o.symbol) ?? q.ask;
      if (o.limitPrice! >= at - 1e-9) this.fill(o, o.limitPrice!);
    } else if (o.kind === "sell") {
      if (o.limitPrice! <= q.bid + 1e-9) this.fill(o, o.limitPrice!);
    } else if (q.bid <= o.stopPrice! + 1e-9) this.fill(o, q.bid);
  }

  private add(
    kind: SimOrder["kind"],
    symbol: string,
    qty: number,
    limitPrice: number | null,
    stopPrice: number | null,
  ): Order {
    if (kind !== "buy") {
      const selling = [...this.orders.values()]
        .filter((o) => o.symbol === symbol && o.side === "sell" && this.open(o))
        .reduce((sum, o) => sum + (o.qty - o.filledQty), 0);
      const free = (this.held.get(symbol)?.qty ?? 0) - selling;
      if (qty > free)
        throw new Error(
          `sim: sell of ${qty} ${symbol} refused, ${Math.max(free, 0)} free`,
        );
    }
    const o: SimOrder = {
      id: `sim-${this.nextId++}`,
      symbol,
      status: "new",
      qty,
      filledQty: 0,
      filledAvgPrice: null,
      limitPrice,
      stopPrice,
      side: kind === "buy" ? "buy" : "sell",
      kind,
    };
    this.orders.set(o.id, o);
    this.settle(o);
    return { ...o };
  }

  private get(id: string) {
    const o = this.orders.get(id);
    if (!o) throw new Error(`sim: no order ${id}`);
    return o;
  }

  async equity() {
    let value = this.cash;
    for (const [symbol, h] of this.held)
      value += h.qty * (this.quotes.get(symbol)?.bid ?? 0) * 100;
    return value;
  }
  async chain(underlying: string, right: string, from: string, to: string) {
    return [...this.quotes.values()].filter(
      (q) =>
        q.underlying === underlying &&
        q.right === right &&
        q.expiry >= from &&
        q.expiry <= to,
    );
  }
  async quote(symbol: string) {
    const q = this.quotes.get(symbol);
    if (!q) throw new Error(`No quote for ${symbol}`);
    return q;
  }
  async buyLimit(symbol: string, qty: number, limitPrice: number) {
    return this.add("buy", symbol, qty, limitPrice, null);
  }
  async sellLimit(symbol: string, qty: number, limitPrice: number) {
    return this.add("sell", symbol, qty, limitPrice, null);
  }
  async sellStop(symbol: string, qty: number, stop: number) {
    return this.add("stop", symbol, qty, null, stop);
  }
  async replace(id: string, limitPrice: number) {
    const o = this.get(id);
    if (!this.open(o)) throw new Error(`sim: order ${id} is ${o.status}`);
    o.limitPrice = limitPrice;
    this.settle(o);
    return { ...o };
  }
  async replaceStop(id: string, qty: number, stop: number) {
    const o = this.get(id);
    if (!this.open(o)) throw new Error(`sim: order ${id} is ${o.status}`);
    o.qty = qty;
    o.stopPrice = stop;
    return { ...o };
  }
  async cancel(id: string) {
    const o = this.get(id);
    if (this.open(o)) o.status = "canceled";
  }
  async order(id: string) {
    return { ...this.get(id) };
  }
  async position(symbol: string) {
    const h = this.held.get(symbol);
    if (!h) throw new Error(`sim: no position in ${symbol}`);
    return { qty: h.qty, avgEntryPrice: h.cost / h.qty };
  }
  async positions(): Promise<Position[]> {
    return [...this.held].map(([symbol, h]) => ({
      symbol,
      qty: h.qty,
      avgEntryPrice: h.cost / h.qty,
    }));
  }
  async openOrders(symbol?: string): Promise<OpenOrder[]> {
    return [...this.orders.values()]
      .filter((o) => this.open(o) && (!symbol || o.symbol === symbol))
      .map((o) => ({ ...o }));
  }
}
