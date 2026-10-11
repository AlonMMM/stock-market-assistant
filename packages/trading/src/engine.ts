import { newYork } from "../../market-data/src/calendar.js";
import type { Broker } from "./broker.js";
import { sellAtBid } from "./exit.js";
import { buyWithLadder } from "./ladder.js";
import type { Notifier, Sent } from "./notifier.js";
import {
  ceilingPrice,
  comingFriday,
  defaultDeltaRange,
  defaultStopPct,
  expiryChoices,
  parseOccSymbol,
  pickByDelta,
  sizeContracts,
  spreadCheck,
  stopPrice,
  type Right,
} from "./options.js";
import { protectFill } from "./protect.js";
import { shortRisks, uncovered } from "./safety.js";

// The trade flow, written against a broker and a notifier
// (docs/tasks/backend-trading-service.md). The command line and the trading
// service both run it, so they cannot behave differently. The rules it applies
// are in docs/tasks/backend-option-orders.md.

/** Remembers the post of each open trade, so its exits are attached to it. */
export interface PostStore {
  get(symbol: string): Promise<string | undefined>;
  set(symbol: string, ref: string | null): Promise<void>;
}

export class MemoryPostStore implements PostStore {
  private posts = new Map<string, string>();
  async get(symbol: string) {
    return this.posts.get(symbol);
  }
  async set(symbol: string, ref: string | null) {
    if (ref === null) this.posts.delete(symbol);
    else this.posts.set(symbol, ref);
  }
}

export interface EngineOptions {
  broker: Broker;
  notifier: Notifier;
  posts: PostStore;
  log?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PreviewRequest {
  underlying: string;
  right: Right;
  sizePct: number;
  delta?: number; // the target; without it, the middle of the default range
  stopPct?: number;
}

export interface BuyRequest {
  contract: string;
  sizePct: number;
  stopPct?: number;
  steps?: number;
  intervalMs?: number;
  waitMs?: number; // how long an unfilled order is watched, then canceled
}

export interface SellRequest {
  contract?: string;
  underlying?: string; // when it has exactly one option position
  qty: string; // all, half or a number of contracts
  stopPct?: number; // for a remainder that had no stop before
  waitMs?: number;
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);

export class TradeEngine {
  private readonly broker: Broker;
  private readonly notifier: Notifier;
  private readonly posts: PostStore;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly sleep?: (ms: number) => Promise<void>;

  constructor(options: EngineOptions) {
    this.broker = options.broker;
    this.notifier = options.notifier;
    this.posts = options.posts;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep;
  }

  private get paper() {
    return this.broker.capabilities.paper;
  }

  private get timing() {
    return {
      log: this.log,
      ...(this.sleep ? { sleep: this.sleep } : {}),
    };
  }

  /** The contract of each offered expiry, priced and sized. Sends nothing. */
  async preview(request: PreviewRequest) {
    const underlying = request.underlying.toUpperCase();
    const { right, sizePct } = request;
    const stopPct = request.stopPct ?? defaultStopPct;
    const [deltaLow, deltaHigh] = defaultDeltaRange;
    const targetDelta = request.delta ?? (deltaLow + deltaHigh) / 2;
    const today = newYork(this.now()).date;
    const equity = await this.broker.equity();
    let quotes = await this.broker.chain(
      underlying,
      right,
      today,
      comingFriday(today),
    );
    if (!quotes.length)
      quotes = await this.broker.chain(
        underlying,
        right,
        today,
        addDays(today, 21),
      );
    const choices = expiryChoices(
      quotes.map((q) => q.expiry),
      today,
    );
    if (!choices) throw new Error(`No ${right}s listed for ${underlying}`);
    const expiries = [...new Set([choices.nearest, choices.friday])].filter(
      (e): e is string => e !== null,
    );
    const rows = expiries.map((expiry) => {
      const q = pickByDelta(
        quotes.filter((x) => x.expiry === expiry),
        targetDelta,
      );
      if (!q) return { expiry, error: "no quote with a delta" };
      const check = spreadCheck(q);
      const ceiling = ceilingPrice(q);
      const size = sizeContracts(equity, sizePct, ceiling);
      return {
        expiry,
        label:
          expiry === choices.nearest && expiry === choices.friday
            ? "nearest = Friday"
            : expiry === choices.nearest
              ? "nearest"
              : "Friday",
        contract: q.symbol,
        strike: q.strike,
        delta: q.delta,
        ...(request.delta === undefined && q.delta !== null
          ? {
              deltaInRange:
                Math.abs(q.delta) >= deltaLow - 1e-9 &&
                Math.abs(q.delta) <= deltaHigh + 1e-9,
            }
          : {}),
        bid: q.bid,
        ask: q.ask,
        mid: Number(check.mid.toFixed(3)),
        spreadPctOfMid: Number((check.ratio * 100).toFixed(1)),
        spreadOk: check.ok,
        ceiling,
        stopAtCeiling: stopPrice(ceiling, stopPct),
        qty: size.qty,
        maxCost: Number(size.cost.toFixed(2)),
        budget: Number(size.budget.toFixed(2)),
      };
    });
    return {
      paper: this.paper,
      equity,
      sizePct,
      targetDelta:
        request.delta === undefined
          ? `${deltaLow.toFixed(2)}–${deltaHigh.toFixed(2)}`
          : String(targetDelta),
      stopPct,
      rows,
    };
  }

  /**
   * Buys one contract symbol: price raises, then a watch that keeps a stop on
   * what fills and cancels what does not. Posts the entry when any filled.
   */
  async buy(request: BuyRequest) {
    const symbol = request.contract.toUpperCase();
    const stopPct = request.stopPct ?? defaultStopPct;
    stopPrice(1, stopPct); // refuse a bad stop before anything is sent
    const equity = await this.broker.equity();
    const quote = await this.broker.quote(symbol);
    const ceiling = ceilingPrice(quote);
    const { qty, budget } = sizeContracts(equity, request.sizePct, ceiling);
    if (qty < 1)
      throw new Error(
        `Budget ${budget.toFixed(2)} buys no contract at ${ceiling}`,
      );
    const result = await buyWithLadder(this.broker, symbol, qty, {
      ...(request.steps === undefined ? {} : { steps: request.steps }),
      ...(request.intervalMs === undefined
        ? {}
        : { intervalMs: request.intervalMs }),
      maxPrice: budget / (qty * 100),
      ...this.timing,
    });
    if (
      result.status === "rejected-spread" ||
      result.status === "rejected-budget"
    )
      return { paper: this.paper, qty, budget, result };
    const guarded = await protectFill(this.broker, result.order!, stopPct, {
      ...(request.waitMs === undefined ? {} : { waitMs: request.waitMs }),
      ...this.timing,
    });
    const order = guarded.order;
    const final = {
      ...result,
      order,
      status:
        order.status === "filled"
          ? ("filled" as const)
          : guarded.cancelError
            ? result.status
            : ("closed" as const),
    };
    const { stop, canceledQty, cancelError } = guarded;
    const outcome = {
      paper: this.paper,
      qty,
      budget,
      result: final,
      stop,
      canceledQty,
      cancelError,
    };
    if (!(order.filledQty > 0)) return outcome;
    const post = await this.notifier.entry(
      { symbol, paper: this.paper, stop },
      final,
    );
    if (post.ok && post.ref) await this.posts.set(symbol, post.ref);
    return { ...outcome, post };
  }

  /** Sells at the bid, re-priced every 5 seconds; posts the exit. */
  async sell(request: SellRequest) {
    let symbol = request.contract?.toUpperCase();
    if (!symbol) {
      const underlying = request.underlying?.toUpperCase();
      if (!underlying) throw new Error("Need a contract or an underlying");
      const held = (await this.broker.positions()).filter(
        (p) => p.qty > 0 && parseOccSymbol(p.symbol).underlying === underlying,
      );
      if (held.length !== 1)
        throw new Error(
          held.length === 0
            ? `No option position in ${underlying}`
            : `Several ${underlying} positions; name the contract: ${held.map((p) => `${p.symbol} (${p.qty})`).join(", ")}`,
        );
      symbol = held[0]!.symbol;
    }
    const result = await sellAtBid(this.broker, symbol, request.qty, {
      ...(request.waitMs === undefined ? {} : { maxMs: request.waitMs }),
      stopPct: request.stopPct ?? defaultStopPct,
      ...this.timing,
    });
    const outcome = { paper: this.paper, symbol, result };
    if (!(result.sold > 0)) return outcome;
    const post = await this.notifier.exit(
      { symbol, paper: this.paper },
      result,
      await this.posts.get(symbol),
    );
    if (result.remaining === 0) await this.posts.set(symbol, null);
    return { ...outcome, post };
  }

  /** Places the stop for a contract already held, at its average entry. */
  async setStop(request: { contract: string; stopPct?: number }) {
    const symbol = request.contract.toUpperCase();
    const stopPct = request.stopPct ?? defaultStopPct;
    const held = await this.broker.position(symbol);
    if (!(held.qty > 0)) throw new Error(`No long position in ${symbol}`);
    // Only contracts that no open sell order already covers: a second stop
    // on the same contracts could sell them twice.
    const qty = uncovered(
      held.qty,
      symbol,
      await this.broker.openOrders(symbol),
    );
    if (qty === 0)
      return {
        paper: this.paper,
        held: held.qty,
        note: "open sell orders already cover it",
      };
    const price = stopPrice(held.avgEntryPrice, stopPct);
    const order = await this.broker.sellStop(symbol, qty, price);
    return {
      paper: this.paper,
      entry: held.avgEntryPrice,
      stopPct,
      price,
      qty,
      order,
    };
  }

  /**
   * The account must never be short an option: any short position, or sell
   * orders for more than is held, is returned and sent as an alert.
   */
  async shortCheck(): Promise<{ problems: string[]; alert?: Sent }> {
    const problems = shortRisks(
      await this.broker.positions(),
      await this.broker.openOrders(),
    );
    if (problems.length === 0) return { problems };
    const alert = await this.notifier.alert(
      `SHORT OPTION RISK${this.paper ? " (paper)" : ""}`,
      problems,
    );
    return { problems, alert };
  }
}
