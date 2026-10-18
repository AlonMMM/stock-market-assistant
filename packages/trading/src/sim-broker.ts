import type { OptionBuyOrder } from "./option-tickets.js";
import type {
  Broker,
  BrokerCapabilities,
  OpenOrder,
  Order,
  OrderChange,
  Position,
  SpreadTicket,
  StockQuote,
  StockTicket,
} from "./broker.js";
import { parseOccSymbol, type OptionQuote } from "./options.js";

// A broker that exists only in memory, for tests and practice runs. It fills
// a buy at its limit once the limit reaches the ask (or `fillAt`), fills a
// sell at its limit once the limit is at or below the bid, and, like Alpaca,
// refuses a sell for more contracts than are free.

const isOption = (symbol: string) => /^[A-Z.]{1,6}\d{6}[CP]\d{8}$/.test(symbol);
const multiplier = (symbol: string) => (isOption(symbol) ? 100 : 1);

interface SimOrder extends OpenOrder {
  kind: "buy" | "sell" | "stop" | "spread";
  // A stock order of a given type (`stockOrder`): how it fills.
  ticket?: {
    type: StockTicket["type"];
    triggered: boolean; // a stop or trailing stop has been reached
    mark?: number; // a trailing stop's best price so far
  };
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
  isOpen = true; // the market
  lastEquity: number;
  history: { date: string; equity: number }[] = [];
  /** Buy limit at which a buy fills; the ask when not set. */
  fillAt = new Map<string, number>();
  readonly orders = new Map<string, SimOrder>();
  private held = new Map<string, { qty: number; cost: number }>();
  private quotes = new Map<string, OptionQuote>();
  /** Latest stock prices, by symbol. */
  readonly stocks = new Map<string, number>();
  private stockQuotes = new Map<string, StockQuote>();
  private nextId = 1;

  constructor(equity = 100_000) {
    this.cash = equity;
    this.lastEquity = equity;
  }

  /** Sets or moves a contract's quote. */
  setQuote(
    symbol: string,
    bid: number,
    ask: number,
    delta: number | null,
    quotedAt?: number,
  ) {
    this.quotes.set(symbol, {
      symbol,
      ...parseOccSymbol(symbol),
      bid,
      ask,
      delta,
      ...(quotedAt === undefined ? {} : { quotedAt }),
    });
    for (const o of this.orders.values()) this.settle(o);
  }

  /** Sets or moves a stock's bid and ask. */
  setStockQuote(symbol: string, bid: number | null, ask: number | null) {
    this.stockQuotes.set(symbol, {
      symbol,
      bid,
      ask,
      last: this.stocks.get(symbol) ?? null,
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
      this.cash -= qty * price * multiplier(o.symbol);
    } else {
      const left = h.qty - qty;
      if (left === 0) this.held.delete(o.symbol);
      else
        this.held.set(o.symbol, {
          qty: left,
          cost: (h.cost / h.qty) * left,
        });
      this.cash += qty * price * multiplier(o.symbol);
    }
    o.filledQty = o.qty;
    o.filledAvgPrice = price;
    o.status = "filled";
  }

  /**
   * A spread fills at its limit once that reaches the natural price: each
   * bought leg at its ask less each sold leg at its bid.
   */
  private settleSpread(o: SimOrder) {
    const legs = o.legs!;
    const quotes = legs.map((l) => this.quotes.get(l.symbol));
    if (quotes.some((q) => !q)) return;
    const natural = legs.reduce(
      (sum, l, i) =>
        sum + (l.side === "buy" ? quotes[i]!.ask : -quotes[i]!.bid),
      0,
    );
    if (o.limitPrice! < natural - 1e-9) return;
    legs.forEach((l, i) => {
      const price = l.side === "buy" ? quotes[i]!.ask : quotes[i]!.bid;
      const h = this.held.get(l.symbol) ?? { qty: 0, cost: 0 };
      const qty = l.side === "buy" ? o.qty : -o.qty;
      const after = h.qty + qty;
      // Closing keeps the average entry; opening adds at this price.
      const cost =
        Math.sign(h.qty) === -Math.sign(qty) && h.qty !== 0
          ? (h.cost / h.qty) * after
          : h.cost + qty * price;
      if (after === 0) this.held.delete(l.symbol);
      else this.held.set(l.symbol, { qty: after, cost });
      this.cash -= qty * price * 100;
    });
    o.filledQty = o.qty;
    o.filledAvgPrice = o.limitPrice;
    o.status = "filled";
  }

  private settle(o: SimOrder) {
    if (!this.open(o)) return;
    if (o.kind === "spread") return this.settleSpread(o);
    const stock = this.stockQuotes.get(o.symbol);
    const q = this.quotes.get(o.symbol) ?? {
      bid: stock?.bid ?? 0,
      ask: stock?.ask ?? Infinity,
    };
    if (!this.quotes.has(o.symbol) && !stock) return;
    if (o.ticket) return this.settleTicket(o, q);
    if (o.kind === "buy") {
      const at = this.fillAt.get(o.symbol) ?? q.ask;
      if (o.limitPrice! >= at - 1e-9) this.fill(o, o.limitPrice!);
    } else if (o.kind === "sell") {
      if (o.limitPrice! <= q.bid + 1e-9) this.fill(o, o.limitPrice!);
    } else if (q.bid <= o.stopPrice! + 1e-9) this.fill(o, q.bid);
  }

  // Stock orders by type: market at the ask or bid; limit at its price once
  // the market reaches it; a stop becomes market (or its limit) once reached;
  // a trailing stop follows the best price by its trail.
  private settleTicket(o: SimOrder, q: { bid: number; ask: number }) {
    const t = o.ticket!;
    const buy = o.side === "buy";
    const here = buy ? q.ask : q.bid;
    if (!(here > 0) || !Number.isFinite(here)) return;
    if (t.type === "trailing_stop") {
      t.mark =
        t.mark === undefined
          ? here
          : buy
            ? Math.min(t.mark, here)
            : Math.max(t.mark, here);
      const trail = o.trailPrice ?? ((o.trailPercent ?? 0) / 100) * t.mark;
      o.stopPrice = Number((buy ? t.mark + trail : t.mark - trail).toFixed(4));
    }
    if (t.type !== "market" && t.type !== "limit" && !t.triggered)
      t.triggered = buy
        ? here >= o.stopPrice! - 1e-9
        : here <= o.stopPrice! + 1e-9;
    const limited = t.type === "limit" || t.type === "stop_limit";
    if (t.type !== "market" && t.type !== "limit" && !t.triggered) return;
    if (!limited) return this.fill(o, here);
    if (buy ? here <= o.limitPrice! + 1e-9 : here >= o.limitPrice! - 1e-9)
      this.fill(o, o.limitPrice!);
  }

  private add(
    kind: SimOrder["kind"],
    symbol: string,
    qty: number,
    limitPrice: number | null,
    stopPrice: number | null,
    typed?: Pick<
      OpenOrder,
      "type" | "timeInForce" | "trailPercent" | "trailPrice" | "extendedHours"
    >,
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
    // Like Alpaca: no buy while a sell stop is open on the same contract.
    if (
      kind === "buy" &&
      [...this.orders.values()].some(
        (o) => o.symbol === symbol && o.kind === "stop" && this.open(o),
      )
    )
      throw new Error("sim: potential wash trade detected");
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
      ...(typed
        ? {
            ...typed,
            ticket: {
              type: typed.type as StockTicket["type"],
              triggered: false,
            },
          }
        : {}),
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
      value +=
        h.qty *
        ((isOption(symbol)
          ? this.quotes.get(symbol)?.bid
          : this.stockQuotes.get(symbol)?.bid) ?? 0) *
        multiplier(symbol);
    return value;
  }
  async account() {
    return {
      equity: await this.equity(),
      lastEquity: this.lastEquity,
      buyingPower: this.cash,
    };
  }
  async marketOpen() {
    return this.isOpen;
  }
  async equityHistory() {
    return this.history;
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
  async stockPrice(symbol: string) {
    return this.stocks.get(symbol) ?? null;
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
  async stockQuote(symbol: string) {
    const q = this.stockQuotes.get(symbol);
    if (!q) throw new Error(`No quote for ${symbol}`);
    return { ...q };
  }
  async stockLimit(
    symbol: string,
    side: "buy" | "sell",
    qty: number,
    limitPrice: number,
  ) {
    return this.add(side, symbol, qty, limitPrice, null);
  }
  async optionBuy(symbol: string, qty: number, t: OptionBuyOrder) {
    return this.add(
      "buy",
      symbol,
      qty,
      t.limitPrice ?? null,
      t.stopPrice ?? null,
      {
        type: t.type,
        timeInForce: t.timeInForce,
        trailPercent: null,
        trailPrice: null,
        extendedHours: false,
      },
    );
  }
  async stockOrder(t: StockTicket) {
    const placed = this.add(
      t.side,
      t.symbol,
      t.qty,
      t.limitPrice ?? null,
      t.stopPrice ?? null,
      {
        type: t.type,
        timeInForce: t.timeInForce,
        trailPercent: t.trailPercent ?? null,
        trailPrice: t.trailPrice ?? null,
        extendedHours: t.extendedHours === true,
      },
    );
    const o = this.get(placed.id);
    // Immediate or cancel, fill or kill: what did not fill now is canceled.
    if ((t.timeInForce === "ioc" || t.timeInForce === "fok") && this.open(o))
      o.status = "canceled";
    return { ...o };
  }
  async spreadOrder(t: SpreadTicket) {
    const o: SimOrder = {
      id: `sim-${this.nextId++}`,
      symbol: "",
      status: "new",
      qty: t.qty,
      filledQty: 0,
      filledAvgPrice: null,
      limitPrice: t.limitPrice,
      stopPrice: null,
      side: "",
      kind: "spread",
      legs: t.legs.map((l) => ({ ...l })),
    };
    this.orders.set(o.id, o);
    this.settle(o);
    return { ...o };
  }
  async changeOrder(id: string, c: OrderChange) {
    const o = this.get(id);
    if (!this.open(o)) throw new Error(`sim: order ${id} is ${o.status}`);
    if (c.qty !== undefined) o.qty = c.qty;
    if (c.limitPrice !== undefined) o.limitPrice = c.limitPrice;
    if (c.stopPrice !== undefined) o.stopPrice = c.stopPrice;
    if (c.trail !== undefined) {
      if (o.trailPercent !== null && o.trailPercent !== undefined)
        o.trailPercent = c.trail;
      else o.trailPrice = c.trail;
    }
    if (c.timeInForce !== undefined) o.timeInForce = c.timeInForce;
    this.settle(o);
    return { ...o };
  }
  async stockPositions(): Promise<Position[]> {
    return [...this.held]
      .filter(([symbol]) => !isOption(symbol))
      .map(([symbol, h]) => ({
        symbol,
        qty: h.qty,
        avgEntryPrice: h.cost / h.qty,
      }));
  }
  async positions(): Promise<Position[]> {
    return [...this.held]
      .filter(([symbol]) => isOption(symbol))
      .map(([symbol, h]) => ({
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
