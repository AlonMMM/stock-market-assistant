import type { Broker, Order } from "../../../packages/trading/src/broker.js";
import { finished } from "../../../packages/trading/src/ladder.js";
import type { OptionBuyOrder } from "../../../packages/trading/src/option-tickets.js";
import type { OptionQuote } from "../../../packages/trading/src/options.js";
import type { OrderEvent, OrderStep, RecorderStore } from "./recorder-store.js";

// Every step of every order of an account, as its broker answered it: the
// send, each raise or re-price, each fill with its own price, the end. Wraps
// the account's broker, so the bots, the site and Claude's orders are all
// recorded without changing how any of them trade. A step carries the
// contract's last quote, when one was read within 15 seconds (the ladder and
// the sale read one before every price). Recording never fails an order: an
// error writing a step is logged and the call goes on.

const bookAge = 15_000;

interface Known {
  root: string;
  contract: string;
  side: "buy" | "sell" | null;
  filled: number;
  avg: number;
  done: boolean;
}

export interface OrderRecorderOptions {
  account: string;
  store: Pick<RecorderStore, "addStep">;
  now?: () => number;
  log?: (line: string) => void;
}

/** The account's broker, recording every order step in `store`. */
export function recordingBroker(
  broker: Broker,
  options: OrderRecorderOptions,
): Broker {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const books = new Map<string, { bid: number; ask: number; at: number }>();
  const known = new Map<string, Known>();

  const write = (
    order: Order,
    k: Known,
    event: OrderEvent,
    values: {
      qty?: number | null;
      limit?: number | null;
      price?: number | null;
    },
  ) => {
    const at = now();
    const book = books.get(k.contract);
    const fresh = book && at - book.at <= bookAge ? book : null;
    const s: OrderStep = {
      at,
      account: options.account,
      orderId: order.id,
      rootId: k.root,
      contract: k.contract,
      side: k.side,
      event,
      qty: values.qty ?? null,
      limit: values.limit === undefined ? order.limitPrice : values.limit,
      price: values.price ?? null,
      bid: fresh?.bid ?? null,
      ask: fresh?.ask ?? null,
      bookAt: fresh?.at ?? null,
      filledAt: event === "filled" ? (order.filledAt ?? null) : null,
    };
    try {
      options.store.addStep(s);
    } catch (error) {
      log(
        `order step of ${order.id} not recorded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const endOf = (status: string): OrderEvent | null => {
    if (status === "filled") return "filled";
    if (status === "canceled") return "canceled";
    if (status === "expired" || status === "done_for_day") return "expired";
    if (status === "rejected") return "rejected";
    if (status === "replaced") return "replaced";
    return null;
  };

  /** What changed on an order since it was last seen: new fills, its end. */
  const observe = (order: Order) => {
    let k = known.get(order.id);
    if (!k) {
      // An order of before the start: its past fills are not steps of now.
      k = {
        root: order.id,
        contract: order.symbol,
        side: null,
        filled: order.filledQty,
        avg: order.filledAvgPrice ?? 0,
        done: finished.has(order.status) || order.status === "replaced",
      };
      known.set(order.id, k);
      return;
    }
    if (order.filledQty > k.filled) {
      const qty = order.filledQty - k.filled;
      const avg = order.filledAvgPrice ?? 0;
      // This step's own price, from the change of the average.
      const price = (avg * order.filledQty - k.avg * k.filled) / qty;
      const done = order.status === "filled";
      write(order, k, done ? "filled" : "fill", {
        qty,
        price: Number(price.toFixed(4)),
      });
      k.filled = order.filledQty;
      k.avg = avg;
      if (done) k.done = true;
    }
    if (!k.done) {
      const end = endOf(order.status);
      if (end) {
        write(order, k, end, {
          qty: order.filledQty,
          price: order.filledAvgPrice,
        });
        k.done = true;
      }
    }
  };

  const sent = (
    order: Order,
    side: "buy" | "sell",
    qty: number,
    limit: number | null,
  ) => {
    const k: Known = {
      root: order.id,
      contract: order.symbol,
      side,
      filled: 0,
      avg: 0,
      done: false,
    };
    known.set(order.id, k);
    write(order, k, "sent", { qty, limit });
    observe(order);
    return order;
  };

  /**
   * A price change: the new order carries on the old one's chain. A
   * replacement is a new order at the broker, counting its own fills from 0
   * (the old one keeps what it filled), so a fill in its answer is a step.
   */
  const changed = (old: string, order: Order, event: OrderEvent) => {
    const before = known.get(old);
    if (order.id !== old && before) {
      known.set(order.id, { ...before, filled: 0, avg: 0, done: false });
    }
    const k = known.get(order.id);
    if (k) write(order, k, event, {});
    observe(order);
    return order;
  };

  const wrapped: Partial<Broker> = {
    quote: async (symbol: string): Promise<OptionQuote> => {
      const q = await broker.quote(symbol);
      if (Number.isFinite(q.bid) && Number.isFinite(q.ask))
        books.set(symbol, { bid: q.bid, ask: q.ask, at: now() });
      return q;
    },
    buyLimit: async (symbol: string, qty: number, limit: number) =>
      sent(await broker.buyLimit(symbol, qty, limit), "buy", qty, limit),
    sellLimit: async (symbol: string, qty: number, limit: number) =>
      sent(await broker.sellLimit(symbol, qty, limit), "sell", qty, limit),
    sellStop: async (symbol: string, qty: number, stop: number) =>
      sent(await broker.sellStop(symbol, qty, stop), "sell", qty, stop),
    replace: async (id: string, limit: number) => {
      const order = await broker.replace(id, limit);
      const side = known.get(id)?.side;
      return changed(id, order, side === "sell" ? "repriced" : "raised");
    },
    replaceStop: async (id: string, qty: number, stop: number) =>
      changed(id, await broker.replaceStop(id, qty, stop), "stop-moved"),
    cancel: async (id: string) => {
      await broker.cancel(id);
      const k = known.get(id);
      if (k && !k.done)
        write(
          {
            id,
            symbol: k.contract,
            status: "pending_cancel",
            qty: 0,
            filledQty: k.filled,
            filledAvgPrice: k.avg,
            limitPrice: null,
          },
          k,
          "cancel",
          { limit: null },
        );
    },
    order: async (id: string) => {
      const order = await broker.order(id);
      observe(order);
      return order;
    },
  };
  if (broker.optionBuy) {
    const optionBuy = broker.optionBuy.bind(broker);
    wrapped.optionBuy = async (
      symbol: string,
      qty: number,
      order: OptionBuyOrder,
    ) => {
      const placed = await optionBuy(symbol, qty, order);
      const limit = order.limitPrice ?? order.stopPrice ?? null;
      return sent(placed, "buy", qty, limit);
    };
  }

  return new Proxy(broker, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in wrapped)
        return wrapped[prop as keyof Broker];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
