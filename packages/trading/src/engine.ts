import { newYork } from "../../market-data/src/calendar.js";
import type { Broker, Order } from "./broker.js";
import {
  checkBuy,
  defaultBuyLimits,
  openRisk,
  type BuyLimits,
  type HeldPosition,
} from "./checks.js";
import { sellAtBid } from "./exit.js";
import {
  explainBuy,
  type Decision,
  type DecisionLog,
  type ExplainParts,
} from "./explain.js";
import { buyWithLadder, finished, type LadderResult } from "./ladder.js";
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
  roundToTick,
  spreadCheck,
  stepPrice,
  stopPrice,
  type OptionQuote,
  type Right,
} from "./options.js";
import { protectFill, type ProtectResult } from "./protect.js";
import {
  accountState,
  checkRisk,
  defaultRiskRules,
  type RiskRules,
} from "./risk-manager.js";
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

/** One buy command. `filled` is null while its order is still working. */
export interface BuyRecord {
  id: string;
  day: string; // New York trading day
  symbol: string;
  at: number;
  filled: boolean | null;
}

/** The buys of each day, for the daily limit and the repeat check. */
export interface BuyLog {
  list(day: string): Promise<BuyRecord[]>;
  put(record: BuyRecord): Promise<void>;
}

export class MemoryBuyLog implements BuyLog {
  private records = new Map<string, BuyRecord>();
  async list(day: string) {
    return [...this.records.values()].filter((r) => r.day === day);
  }
  async put(record: BuyRecord) {
    this.records.set(record.id, record);
  }
}

export interface EngineOptions {
  broker: Broker;
  notifier: Notifier;
  posts: PostStore;
  buys: BuyLog;
  // Where the explanation of each buy is kept; nowhere when absent.
  decisions?: DecisionLog;
  limits?: BuyLimits;
  riskRules?: RiskRules;
  // The kill switch: false refuses every buy. Sells and stops still work.
  enabled?: boolean;
  // The expiry bought when a command names none: the nearest one. The
  // coming Friday's only when the command says so (user 2026-10-11).
  defaultExpiry?: "nearest" | "friday";
  log?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface ChooseRequest {
  underlying: string;
  right: Right;
  delta?: number; // the target; without it, the middle of the default range
  strike?: number; // exact strike, which does not require a published delta
}

export interface PreviewRequest extends ChooseRequest {
  sizePct: number;
  stopPct?: number;
  strike?: number;
}

export interface BuyRequest {
  // Either the contract itself, or what to pick it from.
  contract?: string;
  underlying?: string;
  right?: Right;
  delta?: number;
  strike?: number; // exact strike, even when the broker has no delta
  // "nearest", "friday" or a date; the engine's default when absent.
  expiry?: string;
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

interface BuyBase {
  paper: boolean;
  contract: string;
  qty: number;
}
/** A check failed: nothing was sent. */
export interface BuyRefused extends BuyBase {
  refused: string[];
}
/** The order flow ran; `stop` is absent when the ladder itself sent nothing. */
export interface BuyDone extends BuyBase {
  budget: number;
  result: LadderResult;
  stop?: ProtectResult["stop"];
  canceledQty?: number;
  cancelError?: string;
  post?: Sent; // set when any contract filled
  offHours?: boolean; // the order was sent while the market was closed
}

/** Where a running buy stands, for whoever started it. */
export interface BuyProgress {
  stage: string;
  orderId?: string; // the order at the broker, once there is one
}
export type BuyOutcome = BuyRefused | BuyDone;
/** A buy that passed every check and has not been sent yet. */
export interface BuyPlan extends BuyBase {
  // The market is closed: the order waits at the broker for the open.
  offHours: boolean;
  notes: string[]; // from the checks; they do not stop the order
  budget: number;
  stopPct: number;
  record: BuyRecord;
  decision: Decision;
  steps?: number;
  intervalMs?: number;
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
  private readonly buys: BuyLog;
  private readonly decisions: DecisionLog;
  private readonly limits: BuyLimits;
  private readonly riskRules: RiskRules;
  private readonly enabled: boolean;
  private readonly defaultExpiry: "nearest" | "friday";
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly sleep?: (ms: number) => Promise<void>;

  constructor(options: EngineOptions) {
    this.broker = options.broker;
    this.notifier = options.notifier;
    this.posts = options.posts;
    this.buys = options.buys;
    this.decisions = options.decisions ?? { put: async () => {} };
    this.limits = options.limits ?? defaultBuyLimits;
    this.riskRules = options.riskRules ?? defaultRiskRules;
    this.enabled = options.enabled ?? true;
    this.defaultExpiry = options.defaultExpiry ?? "nearest";
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

  /** The contract a buy would pick in each offered expiry. */
  private async choose(request: ChooseRequest) {
    const underlying = request.underlying.toUpperCase();
    const { right } = request;
    const [deltaLow, deltaHigh] = defaultDeltaRange;
    const targetDelta = request.delta ?? (deltaLow + deltaHigh) / 2;
    const today = newYork(this.now()).date;
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
    return {
      choices,
      // Only an automatically selected strike is held to the default range.
      deltaRange:
        request.delta === undefined && request.strike === undefined
          ? defaultDeltaRange
          : undefined,
      targetDelta:
        request.strike !== undefined
          ? `manual strike ${request.strike}`
          : request.delta === undefined
            ? `${deltaLow.toFixed(2)}–${deltaHigh.toFixed(2)}`
            : String(targetDelta),
      rows: expiries.map((expiry) => {
        const candidates = quotes.filter((x) => x.expiry === expiry);
        return {
          expiry,
          label:
            expiry === choices.nearest && expiry === choices.friday
              ? "nearest = Friday"
              : expiry === choices.nearest
                ? "nearest"
                : "Friday",
          quote:
            request.strike === undefined
              ? pickByDelta(candidates, targetDelta)
              : candidates.find(
                    (q) => Math.abs(q.strike - request.strike!) < 1e-9,
                  ) ?? null,
          candidates,
        };
      }),
    };
  }

  /** What the account-level checks need, read once per request. */
  private async account() {
    const now = this.now();
    const day = newYork(now).date;
    const [account, marketOpen, positions, orders, history, buys] =
      await Promise.all([
        this.broker.account(),
        this.broker.marketOpen(),
        this.broker.positions(),
        this.broker.openOrders(),
        this.broker.equityHistory(),
        this.buys.list(day),
      ]);
    const held: HeldPosition[] = positions.map((p) => {
      const stops = orders.filter(
        (o) =>
          o.symbol === p.symbol && o.side === "sell" && o.stopPrice !== null,
      );
      return {
        ...p,
        stopQty: stops.reduce((sum, o) => sum + (o.qty - o.filledQty), 0),
        stopPrice:
          stops.length > 0 ? Math.min(...stops.map((o) => o.stopPrice!)) : null,
      };
    });
    return {
      now,
      day,
      account,
      marketOpen,
      held,
      shortRisks: shortRisks(positions, orders),
      // Closes before today; today is measured by the day's loss.
      history: history.filter((d) => d.date < day),
      // A buy that ended with nothing filled does not count.
      buysToday: buys.filter((b) => b.filled !== false),
    };
  }

  /** Sizes one contract and runs every check on it. Sends nothing. */
  private assess(
    a: Awaited<ReturnType<TradeEngine["account"]>>,
    quote: OptionQuote,
    sizePct: number,
    stopPct: number,
    deltaRange?: readonly [number, number],
  ) {
    const ceiling = ceilingPrice(quote);
    const sized =
      sizePct > 0 &&
      sizePct <= this.limits.maxSizePct &&
      ceiling > 0 &&
      a.account.equity > 0
        ? sizeContracts(a.account.equity, sizePct, ceiling)
        : { qty: 0, cost: 0, budget: 0 };
    const daysToExpiry = Math.round(
      (Date.parse(`${quote.expiry}T00:00:00Z`) -
        Date.parse(`${a.day}T00:00:00Z`)) /
        86400000,
    );
    const risk = checkRisk(
      {
        history: a.history,
        equity: a.account.equity,
        todayLoss: a.account.lastEquity - a.account.equity,
        premium: ceiling * sized.qty * 100,
        daysToExpiry,
      },
      this.riskRules,
    );
    const verdict = checkBuy(
      {
        now: a.now,
        enabled: this.enabled,
        paper: this.paper,
        shortRisks: a.shortRisks,
        marketOpen: a.marketOpen,
        equity: a.account.equity,
        lastEquity: a.account.lastEquity,
        buyingPower: a.account.buyingPower,
        positions: a.held,
        buysToday: a.buysToday,
        order: {
          quote,
          qty: sized.qty,
          ceiling,
          sizePct,
          stopPct,
          ...(deltaRange ? { deltaRange } : {}),
        },
        risk,
      },
      this.limits,
    );
    return { ceiling, ...sized, verdict, risk, daysToExpiry };
  }

  /**
   * What a buy would choose now in each offered expiry, sized, with the
   * result of every check. Sends nothing.
   */
  async preview(request: PreviewRequest) {
    const stopPct = request.stopPct ?? defaultStopPct;
    const [chosen, a] = await Promise.all([
      this.choose(request),
      this.account(),
    ]);
    const rows = chosen.rows.map(({ expiry, label, quote: q }) => {
      if (!q)
        return {
          expiry,
          error:
            request.strike === undefined
              ? "no quote with a delta"
              : `no contract at strike ${request.strike}`,
        };
      const spread = spreadCheck(q);
      const size = this.assess(
        a,
        q,
        request.sizePct,
        stopPct,
        chosen.deltaRange,
      );
      const [low, high] = defaultDeltaRange;
      return {
        expiry,
        label,
        contract: q.symbol,
        strike: q.strike,
        delta: q.delta,
        ...(chosen.deltaRange && q.delta !== null
          ? {
              deltaInRange:
                Math.abs(q.delta) >= low - 1e-9 &&
                Math.abs(q.delta) <= high + 1e-9,
            }
          : {}),
        bid: q.bid,
        ask: q.ask,
        mid: Number(spread.mid.toFixed(3)),
        spreadPctOfMid: Number((spread.ratio * 100).toFixed(1)),
        spreadOk: spread.ok,
        ceiling: size.ceiling,
        stopAtCeiling:
          stopPct > 0 && stopPct <= this.limits.maxStopPct
            ? stopPrice(size.ceiling, stopPct)
            : null,
        qty: size.qty,
        maxCost: Number(size.cost.toFixed(2)),
        budget: Number(size.budget.toFixed(2)),
        wouldBuy: size.verdict.ok,
        refused: size.verdict.refused,
        notes: size.verdict.notes,
      };
    });
    return {
      paper: this.paper,
      equity: a.account.equity,
      sizePct: request.sizePct,
      targetDelta: chosen.targetDelta,
      stopPct,
      defaultExpiry: this.defaultExpiry,
      buysToday: a.buysToday.length,
      rows,
    };
  }

  /**
   * Buys in one step: picks the contract (or takes the one named), runs every
   * check, and only then sends the order. A failed check sends nothing and is
   * returned in `refused`.
   */
  async buy(request: BuyRequest): Promise<BuyOutcome> {
    const plan = await this.planBuy(request);
    return "refused" in plan ? plan : this.runBuy(plan);
  }

  /**
   * The first half of a buy: the contract, its size and every check. It
   * sends no order. An accepted plan is recorded as one of the day's buys, so
   * a doubled command is refused while the first is still working.
   */
  async planBuy(request: BuyRequest): Promise<BuyRefused | BuyPlan> {
    const stopPct = request.stopPct ?? defaultStopPct;
    let quote: OptionQuote;
    let deltaRange: readonly [number, number] | undefined;
    let picked: ExplainParts["chosen"];
    if (request.contract) {
      quote = await this.broker.quote(request.contract.toUpperCase());
    } else {
      if (!request.underlying || !request.right)
        throw new Error("Need a contract, or an underlying and call or put");
      const chosen = await this.choose({
        underlying: request.underlying,
        right: request.right,
        ...(request.delta === undefined ? {} : { delta: request.delta }),
        ...(request.strike === undefined ? {} : { strike: request.strike }),
      });
      const want = request.expiry ?? this.defaultExpiry;
      const expiry =
        want === "nearest"
          ? chosen.choices.nearest
          : want === "friday"
            ? chosen.choices.friday
            : want;
      const row = chosen.rows.find((r) => r.expiry === expiry);
      if (!row?.quote) {
        if (request.strike !== undefined)
          throw new Error(
            `No contract at strike ${request.strike} for ${request.underlying.toUpperCase()} ${request.right} expiring ${expiry ?? want}; offered strikes: ${(row?.candidates ?? []).map((q) => q.strike).join(", ") || "none"}`,
          );
        throw new Error(
          `No ${request.right} to buy for ${request.underlying.toUpperCase()} expiring ${expiry ?? want}; offered: ${chosen.rows.map((r) => r.expiry).join(", ")}`,
        );
      }
      quote = row.quote;
      deltaRange = chosen.deltaRange;
      picked = {
        rows: chosen.rows.map((r) => ({ expiry: r.expiry, label: r.label })),
        expiry: row.expiry,
        candidates: row.candidates,
      };
    }
    const symbol = quote.symbol;
    const a = await this.account();
    const sized = this.assess(a, quote, request.sizePct, stopPct, deltaRange);
    const { qty, budget, verdict } = sized;
    const decision: Decision = {
      id: `${a.now}-${symbol}`,
      at: a.now,
      symbol,
      outcome: verdict.ok ? "working" : "refused",
      explanation: explainBuy({
        now: a.now,
        paper: this.paper,
        request,
        defaultExpiry: this.defaultExpiry,
        quote,
        ...(picked ? { chosen: picked } : {}),
        equity: a.account.equity,
        ceiling: sized.ceiling,
        qty,
        budget,
        cost: sized.cost,
        stopPct,
        stopAtCeiling:
          stopPct > 0 && stopPct <= this.limits.maxStopPct && sized.ceiling > 0
            ? stopPrice(sized.ceiling, stopPct)
            : null,
        daysToExpiry: sized.daysToExpiry,
        risk: sized.risk,
        marketOpen: a.marketOpen,
        verdict,
      }),
    };
    // Why this order looks the way it does; kept for refused ones too.
    await this.decisions.put(decision).catch(() => {});
    if (!verdict.ok)
      return {
        paper: this.paper,
        contract: symbol,
        qty,
        refused: verdict.refused,
      };
    const record = {
      id: `${a.now}-${symbol}`,
      day: a.day,
      symbol,
      at: a.now,
      filled: null as boolean | null,
    };
    // Recorded before the order goes out, so a doubled command is refused.
    await this.buys.put(record);
    return {
      paper: this.paper,
      contract: symbol,
      qty,
      budget,
      stopPct,
      record,
      decision,
      offHours: !a.marketOpen,
      notes: verdict.notes,
      ...(request.steps === undefined ? {} : { steps: request.steps }),
      ...(request.intervalMs === undefined
        ? {}
        : { intervalMs: request.intervalMs }),
      ...(request.waitMs === undefined ? {} : { waitMs: request.waitMs }),
    };
  }

  /**
   * The second half: price raises, then a watch that keeps a stop on what
   * fills and cancels what does not. Posts the entry when any contract filled.
   */
  async runBuy(
    plan: BuyPlan,
    progress: (p: BuyProgress) => void = () => {},
  ): Promise<BuyDone> {
    const { contract: symbol, qty, budget, stopPct, record } = plan;
    const request = plan;
    let filled = false;
    let done: BuyDone | undefined;
    let failure: unknown;
    try {
      done = await this.workBuy(plan, progress);
      filled = (done.result.order?.filledQty ?? 0) > 0;
      return done;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // One command is one buy however it filled; one that bought nothing
      // does not use up one of the day's buys.
      await this.buys.put({ ...record, filled });
      const order = done?.result.order;
      const got = order?.filledQty ?? 0;
      await this.decisions
        .put({
          ...plan.decision,
          outcome: failure
            ? "failed"
            : got === 0
              ? "not filled"
              : got < qty
                ? "partly filled"
                : "filled",
          result: {
            filledQty: got,
            avgPrice: order?.filledAvgPrice ?? null,
            ...(done?.stop?.price === undefined
              ? {}
              : { stopPrice: done.stop.price, stopQty: done.stop.qty ?? 0 }),
            ...(done?.canceledQty ? { canceledQty: done.canceledQty } : {}),
            ...(failure
              ? {
                  error:
                    failure instanceof Error
                      ? failure.message
                      : String(failure),
                }
              : done?.stop?.error
                ? { error: `stop: ${done.stop.error}` }
                : {}),
          },
        })
        .catch(() => {});
    }
  }

  private async workBuy(
    plan: BuyPlan,
    progress: (p: BuyProgress) => void,
  ): Promise<BuyDone> {
    const { contract: symbol, qty, budget, stopPct } = plan;
    const request = plan;
    {
      let waiting: Order | undefined;
      if (plan.offHours) {
        const queued = await this.queueOffHours(plan, progress);
        if ("result" in queued) return queued;
        waiting = queued.order;
      }
      progress({ stage: "raising the price" });
      const result = await buyWithLadder(this.broker, symbol, qty, {
        ...(waiting ? { existing: waiting } : {}),
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
        return { paper: this.paper, contract: symbol, qty, budget, result };
      progress({
        stage: "watching the order, keeping its stop",
        orderId: result.order!.id,
      });
      const guarded = await protectFill(this.broker, result.order!, stopPct, {
        ...(request.waitMs === undefined ? {} : { waitMs: request.waitMs }),
        ...this.timing,
      });
      const order = guarded.order;
      const filled = order.filledQty > 0;
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
        contract: symbol,
        qty,
        budget,
        result: final,
        stop,
        canceledQty,
        cancelError,
        ...(plan.offHours ? { offHours: true } : {}),
      };
      if (!filled) return outcome;
      const post = await this.notifier.entry(
        {
          symbol,
          paper: this.paper,
          stop,
          ...(plan.offHours ? { note: "Ordered off hours" } : {}),
        },
        final,
      );
      if (post.ok && post.ref) await this.posts.set(symbol, post.ref);
      return { ...outcome, post };
    }
  }

  /** The contract a sell request means: the one named, or the only one held. */
  async sellTarget(request: Pick<SellRequest, "contract" | "underlying">) {
    const named = request.contract?.toUpperCase();
    if (named) return named;
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
    return held[0]!.symbol;
  }

  /**
   * An order sent while the market is closed (user 2026-10-11): it goes to the
   * broker at the last mid and waits there. The user is told on the channel.
   * This watches it until the market opens, then hands it back to be raised
   * and protected like any other buy. If it is canceled first, that is the
   * end of it.
   */
  private async queueOffHours(
    plan: BuyPlan,
    progress: (p: BuyProgress) => void,
  ): Promise<{ order: Order } | BuyDone> {
    const { contract: symbol, qty, budget } = plan;
    const sleep =
      this.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const quote = await this.broker.quote(symbol);
    const spread = spreadCheck(quote);
    const price = Math.min(
      stepPrice(quote, 0, 5),
      roundToTick(budget / (qty * 100), "down"),
    );
    let order = await this.broker.buyLimit(symbol, qty, price);
    this.log(
      `off hours: sent ${qty} @ ${price.toFixed(2)}, waiting for the open`,
    );
    progress({ stage: "waiting for the market to open", orderId: order.id });
    const c = parseOccSymbol(symbol);
    await this.notifier
      .notice(`Off-hours order${this.paper ? " (paper)" : ""}`, [
        `$${c.underlying} | ${c.strike} ${c.right === "call" ? "Call" : "Put"} ${c.expiry}`,
        `${qty} contract${qty === 1 ? "" : "s"}, bidding ${price.toFixed(2)}`,
        "The market is closed. The order waits and is worked at the open.",
      ])
      .catch(() => {});
    // At most a long weekend; then it is withdrawn.
    const pollMs = 30_000;
    let open = false;
    for (let waited = 0; waited < 4 * 86_400_000; waited += pollMs) {
      await sleep(pollMs);
      order = await this.broker.order(order.id);
      if (finished.has(order.status)) break;
      if ((open = await this.broker.marketOpen())) break;
    }
    if (!open && !finished.has(order.status)) {
      await this.broker.cancel(order.id).catch(() => {});
      order = await this.broker.order(order.id);
    }
    if (finished.has(order.status) && !(order.filledQty > 0))
      return {
        paper: this.paper,
        contract: symbol,
        qty,
        budget,
        result: {
          status: "closed",
          quote,
          spreadRatio: spread.ratio,
          prices: [price],
          order,
        },
        canceledQty: order.qty,
        offHours: true,
      };
    // Let the first quotes of the session arrive before raising the price.
    if (!finished.has(order.status)) await sleep(20_000);
    return { order };
  }

  /** Sells at the bid, re-priced every 5 seconds; posts the exit. */
  async sell(request: SellRequest) {
    const symbol = await this.sellTarget(request);
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

  /** Positions with their stops, and today's use of each limit. */
  async status() {
    const a = await this.account();
    const { equity, lastEquity } = a.account;
    const risk = openRisk(a.held);
    const state = accountState(a.history, this.riskRules);
    return {
      paper: this.paper,
      tradingEnabled: this.enabled,
      shortRisks: a.shortRisks,
      equity,
      dayChangePct:
        lastEquity > 0
          ? Number((((equity - lastEquity) / lastEquity) * 100).toFixed(2))
          : null,
      marketOpen: a.marketOpen,
      positions: a.held,
      limits: {
        buysToday: a.buysToday.length,
        maxBuysPerDay: this.limits.maxBuysPerDay,
        openRisk: Number(risk.toFixed(2)),
        openRiskPct:
          equity > 0 ? Number(((risk / equity) * 100).toFixed(2)) : null,
        maxOpenRiskPct: this.limits.maxOpenRiskPct,
        maxDayLossPct: this.limits.maxDayLossPct,
        riskManager: {
          state: state.state,
          reason: state.reason,
          ...this.riskRules.limits[state.state],
        },
      },
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
