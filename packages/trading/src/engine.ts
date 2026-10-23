import { newYork } from "../../market-data/src/calendar.js";
import type { Broker, Order, SpreadTicket } from "./broker.js";
import {
  checkBuy,
  checkSpread,
  defaultBuyLimits,
  openRisk,
  type BuyContext,
  type BuyLimits,
  type BuyVerdict,
  type CheckResult,
  type HeldPosition,
} from "./checks.js";
import { sellAtBid } from "./exit.js";
import {
  explainBuy,
  type Decision,
  type DecisionLog,
  type ExplainParts,
} from "./explain.js";
import {
  buyWithLadder,
  current,
  finished,
  type LadderResult,
} from "./ladder.js";
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
import {
  buyOrder,
  describeTicket,
  optionTicket,
  ticketCeiling,
  type OptionTicket,
} from "./option-tickets.js";
import { protectFill, type ProtectResult } from "./protect.js";
import {
  accountState,
  checkRisk,
  defaultRiskRules,
  type RiskRules,
} from "./risk-manager.js";
import {
  pairedQty,
  shortRisks,
  spreadPairs,
  uncovered,
  type SpreadPair,
} from "./safety.js";

// The trade flow, written against a broker and a notifier
// (docs/tasks/backend-trading-service.md). The command line and the trading
// service both run it, so they cannot behave differently. The rules it applies
// are in docs/tasks/backend-option-orders.md.

/**
 * A buy that cannot be made, for a reason the user can act on. Nothing was
 * sent. `check` names what failed, like the checks of `checkBuy`; `hint` says
 * what would work instead.
 */
export class TradeRefusal extends Error {
  constructor(
    readonly check: string,
    readonly detail: string,
    readonly hint?: string,
  ) {
    super(`${check}: ${detail}`);
  }
}

/** Why no strike of one expiry could be picked by delta. */
export function whyNoPick(
  underlying: string,
  right: Right,
  expiry: string,
  candidates: OptionQuote[],
): { detail: string; hint: string } {
  const kind = `${underlying} ${right}s expiring ${expiry}`;
  const strikes = candidates.map((q) => q.strike).sort((a, b) => a - b);
  const listed =
    strikes.length > 0
      ? `strikes ${strikes[0]} to ${strikes.at(-1)} are listed`
      : "";
  if (candidates.length === 0)
    return {
      detail: `no ${kind} are listed`,
      hint: "Ask for another expiry, or check the ticker.",
    };
  const withDelta = candidates.filter((q) => q.delta !== null);
  if (withDelta.length === 0)
    return {
      detail: `the broker published no delta for any of the ${candidates.length} ${kind}, so no strike can be picked by delta`,
      hint: `Name the strike to buy without a delta (${listed}), or ask for another expiry. Deltas are often missing on the last day of a contract and while the market is closed.`,
    };
  return {
    detail: `none of the ${withDelta.length} ${kind} that have a delta has an ask price`,
    hint: `Nothing is offered for sale there right now. Name a strike (${listed}), or ask for another expiry.`,
  };
}

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
  // The trader's own checks (validators.ts); a failed one refuses the buy.
  validate?: (c: BuyContext) => CheckResult[];
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
  expiry?: string; // a date; it is offered next to the nearest and Friday's
}

export interface PreviewRequest extends ChooseRequest {
  sizePct: number;
  stopPct?: number;
  force?: boolean;
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
  // Size as % of equity; or `qty`, an exact number of contracts, which is
  // then held to the same limits.
  sizePct?: number;
  qty?: number;
  stopPct?: number;
  // Buy whatever the spread is (user 2026-10-12). Every other check applies.
  force?: boolean;
  // The user's own limit price (user 2026-10-17): one day order at this
  // price instead of the raises from the mid; a stop is kept on every fill
  // until it fills or ends at the close.
  limitPrice?: number;
  // The ticket's order (user 2026-10-18): market, limit, stop or stop limit,
  // day or good till canceled; `autoStop: false` places no stop on fills.
  // See option-tickets.ts.
  orderType?: string;
  stopPrice?: number;
  timeInForce?: string;
  autoStop?: boolean;
  steps?: number;
  intervalMs?: number;
  waitMs?: number; // how long an unfilled order is watched, then canceled
  // Keep raising to the ask after the planned raises until filled, for up
  // to `chaseMs` (default chaseDefaultMs), paying up to chaseSlack over the
  // budget (the bot; docs/tasks/backend-indi-bot.md, "Orders").
  chase?: boolean;
  chaseMs?: number;
  // A first line for the posts, such as "🤖 Bot", and a line of why
  // (docs/tasks/backend-indi-bot.md).
  tag?: string;
  note?: string;
}

export const chaseDefaultMs = 10 * 60_000;
export const chaseSlack = 0.1; // the cap while chasing: budget × (1 + this)

/** A two-leg debit spread: buy `long`, sell `short` (user 2026-10-17). */
export interface SpreadRequest {
  long: string;
  short: string;
  // Size as % of equity, measured at the net debit; or `qty` spreads.
  sizePct?: number;
  qty?: number;
  // Net debit per spread; the mid of the two legs when absent.
  limitPrice?: number;
}

/** Closing a held spread: `qty` of it (all when absent) for a net credit. */
export interface SpreadCloseRequest {
  long: string;
  short: string;
  qty?: number;
  // Net credit per spread received; the mid of the two legs when absent.
  limitPrice?: number;
}

/** A spread that passed every check and has not been sent yet. */
export interface SpreadPlan {
  paper: boolean;
  long: string;
  short: string;
  qty: number;
  limitPrice: number;
  maxLoss: number;
  offHours: boolean;
  notes: string[];
  record: BuyRecord;
}

/** How a spread order ended: filled, or what is left of it. */
export interface SpreadDone {
  paper: boolean;
  long: string;
  short: string;
  qty: number;
  limitPrice: number;
  order: Order;
  post?: Sent;
}

export interface SellRequest {
  contract?: string;
  underlying?: string; // when it has exactly one option position
  qty: string; // all, half or a number of contracts
  stopPct?: number; // for a remainder that had no stop before
  waitMs?: number;
  tag?: string; // as in BuyRequest
  note?: string;
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
  // No automatic stop: the order is left at the broker, not watched.
  noStop?: boolean;
  working?: boolean;
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
  force?: boolean;
  limitPrice?: number;
  ticket?: OptionTicket;
  steps?: number;
  intervalMs?: number;
  waitMs?: number;
  chase?: boolean;
  chaseMs?: number;
  tag?: string;
  note?: string;
}

const isOcc = (symbol: string) => /^[A-Z.]{1,6}\d{6}[CP]\d{8}$/.test(symbol);

// How far ahead the trade ticket offers expiries.
const chainDays = 35;
// The longest a day limit order can wait: placed before a long weekend.
const limitWatchMs = 4 * 86_400_000;

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);

/** A verdict with a validator's checks added; a failed one refuses. */
function withChecks(verdict: BuyVerdict, extra: CheckResult[]): BuyVerdict {
  if (extra.length === 0) return verdict;
  const failed = extra.filter((c) => !c.ok);
  return {
    ...verdict,
    ok: verdict.ok && failed.length === 0,
    checks: [...verdict.checks, ...extra],
    refused: [
      ...verdict.refused,
      ...failed.map((c) => `${c.check}: ${c.detail}`),
    ],
  };
}

/** "$NVDA | 240/245 Call 2026-10-16 spread" for posts. */
function spreadName(long: string, short: string) {
  const l = parseOccSymbol(long);
  const s = parseOccSymbol(short);
  return `$${l.underlying} | ${l.strike}/${s.strike} ${l.right === "call" ? "Call" : "Put"} ${l.expiry} spread`;
}

export class TradeEngine {
  private readonly broker: Broker;
  private readonly notifier: Notifier;
  private readonly posts: PostStore;
  private readonly buys: BuyLog;
  private readonly decisions: DecisionLog;
  private readonly limits: BuyLimits;
  private readonly riskRules: RiskRules;
  private readonly validate: (c: BuyContext) => CheckResult[];
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
    this.validate = options.validate ?? (() => []);
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
    // A named date is read on its own: it may be past the coming Friday.
    const named =
      request.expiry && /^\d{4}-\d{2}-\d{2}$/.test(request.expiry)
        ? request.expiry
        : undefined;
    if (named !== undefined && named < today)
      throw new TradeRefusal(
        "expiry",
        `${named} is in the past; today is ${today} in New York`,
      );
    if (named !== undefined && !quotes.some((q) => q.expiry === named))
      quotes = [
        ...quotes,
        ...(await this.broker.chain(underlying, right, named, named)),
      ];
    const choices =
      expiryChoices(
        quotes.filter((q) => q.expiry !== named).map((q) => q.expiry),
        today,
      ) ??
      expiryChoices(
        quotes.map((q) => q.expiry),
        today,
      );
    if (!choices)
      throw new TradeRefusal(
        "options listed",
        `the broker lists no ${right}s for ${underlying} in the next 21 days`,
        "Check the ticker; not every stock has options.",
      );
    const expiries = [
      ...new Set([choices.nearest, choices.friday, named]),
    ].filter((e): e is string => typeof e === "string");
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
                : expiry === choices.friday
                  ? "Friday"
                  : "named",
          quote:
            request.strike === undefined
              ? pickByDelta(candidates, targetDelta)
              : (candidates.find(
                  (q) => Math.abs(q.strike - request.strike!) < 1e-9,
                ) ?? null),
          candidates,
        };
      }),
    };
  }

  /** What the account-level checks need, read once per request. */
  private async account() {
    const now = this.now();
    const day = newYork(now).date;
    const [account, marketOpen, positions, orders, history, buys, shares] =
      await Promise.all([
        this.broker.account(),
        this.broker.marketOpen(),
        this.broker.positions(),
        this.broker.openOrders(),
        this.broker.equityHistory(),
        this.buys.list(day),
        this.broker.stockPositions?.() ?? Promise.resolve([]),
      ]);
    // Option buys only: a stock order (e.g. a resting stock limit buy) is not
    // part of any option position.
    const working = orders
      .filter(
        (o) => o.side === "buy" && o.limitPrice !== null && isOcc(o.symbol),
      )
      .map((o) => ({
        symbol: o.symbol,
        qty: o.qty - o.filledQty,
        price: o.limitPrice!,
      }));
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
      working,
      // Shares count too: an open stock sell covered by held shares is not
      // a short risk.
      shortRisks: shortRisks([...positions, ...shares], orders),
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
    size: { sizePct?: number; qty?: number },
    stopPct: number,
    deltaRange?: readonly [number, number],
    force = false,
    ticket?: OptionTicket,
  ) {
    // The most one contract can cost: the order's own price (option-tickets
    // .ts), else the ceiling of the raises.
    const ceiling = ticket
      ? ticketCeiling(ticket, quote, ceilingPrice(quote))
      : ceilingPrice(quote);
    const { equity } = a.account;
    // An exact number of contracts is measured as the share it costs.
    const exact =
      size.qty !== undefined && ceiling > 0 && equity > 0
        ? { qty: size.qty, cost: size.qty * ceiling * 100 }
        : null;
    const sizePct = exact
      ? Number(((exact.cost / equity) * 100).toFixed(4))
      : (size.sizePct ?? 0);
    const sized = exact
      ? { ...exact, budget: exact.cost }
      : sizePct > 0 &&
          sizePct <= this.limits.maxSizePct &&
          ceiling > 0 &&
          equity > 0
        ? sizeContracts(equity, sizePct, ceiling)
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
    const context: BuyContext = {
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
      working: a.working,
      order: {
        quote,
        qty: sized.qty,
        ceiling,
        sizePct,
        stopPct,
        ...(ticket?.noStop ? { noStop: true } : {}),
        ...(force ? { force } : {}),
        ...(deltaRange ? { deltaRange } : {}),
      },
      risk,
    };
    const verdict = withChecks(
      checkBuy(context, this.limits),
      this.validate(context),
    );
    return { ceiling, ...sized, sizePct, verdict, risk, daysToExpiry };
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
    const rows = chosen.rows.map(({ expiry, label, quote: q, candidates }) => {
      if (!q) {
        if (request.strike !== undefined)
          return {
            expiry,
            error: `no contract at strike ${request.strike}; offered strikes: ${candidates.map((c) => c.strike).join(", ") || "none"}`,
          };
        const why = whyNoPick(
          request.underlying.toUpperCase(),
          request.right,
          expiry,
          candidates,
        );
        return { expiry, error: why.detail, hint: why.hint };
      }
      const spread = spreadCheck(q);
      const size = this.assess(
        a,
        q,
        { sizePct: request.sizePct },
        stopPct,
        chosen.deltaRange,
        request.force,
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
   * One side of a stock's option chain for one expiry, for a person to pick
   * a strike from (the site's trade ticket). Without an expiry: the nearest
   * one, and the expiries of the coming weeks to choose from. `pick` is the
   * strike a buy without a strike or delta would take. `underlyingPrice` is
   * the stock's latest trade, or null when the broker cannot give it.
   */
  async chainFor(request: {
    underlying: string;
    right: Right;
    expiry?: string;
  }) {
    const underlying = request.underlying.toUpperCase();
    const { right } = request;
    // Read alongside the chain. It only marks where the stock trades among
    // the strikes, so the chain is still shown without it.
    const stock: Promise<number | null> = this.broker.stockPrice
      ? this.broker.stockPrice(underlying).catch(() => null)
      : Promise.resolve(null);
    const today = newYork(this.now()).date;
    let expiries: string[] | undefined;
    let expiry = request.expiry;
    let quotes: OptionQuote[];
    if (expiry === undefined) {
      const all = await this.broker.chain(
        underlying,
        right,
        today,
        addDays(today, chainDays),
      );
      expiries = [...new Set(all.map((q) => q.expiry))].sort();
      if (expiries.length === 0)
        throw new TradeRefusal(
          "options listed",
          `the broker lists no ${right}s for ${underlying} in the next ${chainDays} days`,
          "Check the ticker; not every stock has options.",
        );
      expiry = expiries[0]!;
      quotes = all.filter((q) => q.expiry === expiry);
    } else {
      if (expiry < today)
        throw new TradeRefusal(
          "expiry",
          `${expiry} is in the past; today is ${today} in New York`,
        );
      quotes = await this.broker.chain(underlying, right, expiry, expiry);
      if (quotes.length === 0)
        throw new TradeRefusal(
          "expiry",
          `no ${underlying} ${right}s expire on ${expiry}`,
        );
    }
    const [low, high] = defaultDeltaRange;
    const pick = pickByDelta(quotes, (low + high) / 2);
    const underlyingPrice = await stock;
    return {
      paper: this.paper,
      underlying,
      underlyingPrice,
      right,
      expiry,
      ...(expiries ? { expiries } : {}),
      pick: pick?.symbol ?? null,
      maxSpreadPct: this.limits.maxSpreadRatio * 100,
      quotes: quotes
        .sort((a, b) => a.strike - b.strike)
        .map((q) => {
          const spread = spreadCheck(q);
          return {
            contract: q.symbol,
            strike: q.strike,
            bid: q.bid,
            ask: q.ask,
            mid: Number(spread.mid.toFixed(3)),
            spreadPct: Number.isFinite(spread.ratio)
              ? Number((spread.ratio * 100).toFixed(1))
              : null,
            delta: q.delta,
            iv: q.iv ?? null,
            openInterest: q.openInterest ?? null,
          };
        }),
    };
  }

  /**
   * What a buy of this exact contract would be now, with the result of every
   * check. Sends nothing and records nothing.
   */
  async checkContract(request: {
    contract: string;
    sizePct?: number;
    qty?: number;
    stopPct?: number;
    force?: boolean;
    limitPrice?: number;
    orderType?: string;
    stopPrice?: number;
    timeInForce?: string;
    autoStop?: boolean;
  }) {
    const stopPct = request.stopPct ?? defaultStopPct;
    const ticket = optionTicket(request);
    if (request.sizePct === undefined && request.qty === undefined)
      throw new Error("Need a size: sizePct or qty");
    const [quote, a] = await Promise.all([
      this.broker.quote(request.contract.toUpperCase()),
      this.account(),
    ]);
    const sized = this.assess(
      a,
      quote,
      request.qty === undefined
        ? { sizePct: request.sizePct! }
        : { qty: request.qty },
      stopPct,
      undefined,
      request.force,
      ticket,
    );
    const spread = spreadCheck(quote);
    return {
      paper: this.paper,
      contract: quote.symbol,
      equity: a.account.equity,
      marketOpen: a.marketOpen,
      bid: quote.bid,
      ask: quote.ask,
      mid: Number(spread.mid.toFixed(3)),
      delta: quote.delta,
      ceiling: sized.ceiling,
      qty: sized.qty,
      maxCost: Number(sized.cost.toFixed(2)),
      sizePct: sized.sizePct,
      stopPct,
      orderType: ticket.type ?? null,
      limitPrice: ticket.limitPrice ?? null,
      stopPrice: ticket.stopPrice ?? null,
      timeInForce: ticket.timeInForce,
      autoStop: !ticket.noStop,
      stopAtCeiling:
        !ticket.noStop &&
        stopPct > 0 &&
        stopPct <= this.limits.maxStopPct &&
        sized.ceiling > 0
          ? stopPrice(sized.ceiling, stopPct)
          : null,
      wouldBuy: sized.verdict.ok,
      checks: sized.verdict.checks,
      refused: sized.verdict.refused,
      notes: sized.verdict.notes,
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
    const ticket = optionTicket(request);
    if (ticket.type && ticket.type !== "limit" && !this.broker.optionBuy)
      throw new TradeRefusal(
        "order type",
        `${this.broker.name} takes only limit buys for options here`,
      );
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
        ...(request.expiry === undefined ? {} : { expiry: request.expiry }),
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
        if (!row || row.candidates.length === 0)
          throw new TradeRefusal(
            "expiry",
            want === "friday"
              ? `no ${request.underlying.toUpperCase()} ${request.right}s expire by the coming Friday`
              : `no ${request.underlying.toUpperCase()} ${request.right}s expire on ${want}`,
            `Offered: ${chosen.rows
              .filter((r) => r.candidates.length > 0)
              .map((r) => `${r.expiry} (${r.label})`)
              .join(", ")}.`,
          );
        const why = whyNoPick(
          request.underlying.toUpperCase(),
          request.right,
          row.expiry,
          row.candidates,
        );
        throw new TradeRefusal("delta", why.detail, why.hint);
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
    if (request.sizePct === undefined && request.qty === undefined)
      throw new Error("Need a size: sizePct or qty");
    const sized = this.assess(
      a,
      quote,
      request.qty === undefined
        ? { sizePct: request.sizePct! }
        : { qty: request.qty },
      stopPct,
      deltaRange,
      request.force,
      ticket,
    );
    const { qty, budget, verdict } = sized;
    const decision: Decision = {
      id: `${a.now}-${symbol}`,
      at: a.now,
      symbol,
      outcome: verdict.ok ? "working" : "refused",
      explanation: explainBuy({
        now: a.now,
        paper: this.paper,
        request: { ...request, sizePct: sized.sizePct },
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
          !ticket.noStop &&
          stopPct > 0 &&
          stopPct <= this.limits.maxStopPct &&
          sized.ceiling > 0
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
    // An addition takes the position's stop off while it buys. Off hours the
    // order waits, and the stop would be missing at the open.
    if (
      !a.marketOpen &&
      a.held.some((p) => p.symbol === symbol && p.stopQty > 0)
    )
      return {
        paper: this.paper,
        contract: symbol,
        qty,
        refused: [
          "adding off hours: this contract is already held with a stop, and adding to it takes the stop off while the order works; add when the market is open",
        ],
      };
    // An order left at the broker without a stop would keep the position's
    // stop off (it comes off while a buy works) for as long as it waits.
    if (
      ticket.type &&
      ticket.noStop &&
      a.held.some((p) => p.symbol === symbol && p.stopQty > 0)
    )
      return {
        paper: this.paper,
        contract: symbol,
        qty,
        refused: [
          "adding without a stop: this contract is held with a stop, which comes off while a buy works; with auto stop off it would stay off. Turn on auto stop, or use the stepped buy",
        ],
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
      ...(request.force ? { force: true } : {}),
      ...(ticket.type === "limit" && ticket.timeInForce === "day"
        ? { limitPrice: ticket.limitPrice! }
        : {}),
      ticket,
      ...(request.steps === undefined ? {} : { steps: request.steps }),
      ...(request.intervalMs === undefined
        ? {}
        : { intervalMs: request.intervalMs }),
      ...(request.waitMs === undefined ? {} : { waitMs: request.waitMs }),
      ...(request.chase ? { chase: true } : {}),
      ...(request.chaseMs === undefined ? {} : { chaseMs: request.chaseMs }),
      ...(request.tag === undefined ? {} : { tag: request.tag }),
      ...(request.note === undefined ? {} : { note: request.note }),
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
            : got === 0 && done?.working
              ? "working"
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

  /**
   * A buy that adds to a held contract. The broker refuses a buy while a
   * sell stop is open on the same contract ("potential wash trade", seen on
   * Alpaca 2026-10-12), so the position's stop is taken off first and put
   * back, at its old price, on every contract the new stop does not cover.
   * It goes back whatever the buy did, and the user is alerted if it cannot.
   */
  private async workBuy(
    plan: BuyPlan,
    progress: (p: BuyProgress) => void,
  ): Promise<BuyDone> {
    const { contract: symbol } = plan;
    const sleep =
      this.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const stopsOf = async () =>
      (await this.broker.openOrders(symbol)).filter(
        (o) => o.side === "sell" && o.stopPrice !== null,
      );
    const stops = await stopsOf();
    if (stops.length === 0) return this.fillBuy(plan, progress);
    const oldStop = Math.min(...stops.map((o) => o.stopPrice!));
    progress({ stage: "taking the stop off to add to the position" });
    try {
      for (const stop of stops) await this.broker.cancel(stop.id);
      let gone = false;
      for (let i = 0; i < 10 && !gone; i++) {
        await sleep(1000);
        gone = (await stopsOf()).length === 0;
      }
      if (!gone)
        throw new Error(
          "The position's stop could not be taken off, so nothing was bought",
        );
      this.log(`stop ${oldStop.toFixed(2)} taken off to add`);
      return await this.fillBuy(plan, progress);
    } finally {
      try {
        const held = await this.broker.position(symbol).catch(() => null);
        // Only contracts no open sell order covers: never more than is held.
        const free = held
          ? uncovered(held.qty, symbol, await this.broker.openOrders(symbol))
          : 0;
        if (free > 0) {
          await this.broker.sellStop(symbol, free, oldStop);
          this.log(`stop ${oldStop.toFixed(2)} back on ${free}`);
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        this.log(`stop not restored on ${symbol}: ${text}`);
        await this.notifier
          .alert(`NO STOP after adding${this.paper ? " (paper)" : ""}`, [
            symbol,
            `The stop at ${oldStop.toFixed(2)} could not be put back: ${text}`,
            "Set it by hand, or with set_stop.",
          ])
          .catch(() => {});
      }
    }
  }

  private async fillBuy(
    plan: BuyPlan,
    progress: (p: BuyProgress) => void,
  ): Promise<BuyDone> {
    const { contract: symbol, qty, budget, stopPct } = plan;
    const request = plan;
    {
      let result: LadderResult;
      const ticket = plan.ticket;
      if (ticket?.type) {
        // One order of the ticket's type, off hours too: it waits at the
        // broker for the open. A day limit is the plain limit buy.
        const quote = await this.broker.quote(symbol);
        const order =
          ticket.type === "limit" && ticket.timeInForce === "day"
            ? await this.broker.buyLimit(symbol, qty, ticket.limitPrice!)
            : await this.broker.optionBuy!(symbol, qty, buyOrder(ticket)!);
        this.log(`sent ${qty} ${symbol}: ${describeTicket(ticket)}`);
        result = {
          status: order.status === "filled" ? "filled" : "open",
          quote,
          spreadRatio: spreadCheck(quote).ratio,
          prices: [ticket.limitPrice ?? ticket.stopPrice ?? quote.ask],
          order,
        };
      } else {
        let waiting: Order | undefined;
        if (plan.offHours) {
          const queued = await this.queueOffHours(plan, progress);
          if ("result" in queued) return queued;
          waiting = queued.order;
        }
        progress({ stage: "raising the price" });
        result = await buyWithLadder(this.broker, symbol, qty, {
          ...(waiting ? { existing: waiting } : {}),
          ...(plan.force ? { anySpread: true } : {}),
          ...(request.steps === undefined ? {} : { steps: request.steps }),
          ...(request.intervalMs === undefined
            ? {}
            : { intervalMs: request.intervalMs }),
          ...(plan.chase ? { chaseMs: plan.chaseMs ?? chaseDefaultMs } : {}),
          maxPrice: (budget * (plan.chase ? 1 + chaseSlack : 1)) / (qty * 100),
          ...this.timing,
        });
        if (
          result.status === "rejected-spread" ||
          result.status === "rejected-budget"
        )
          return { paper: this.paper, contract: symbol, qty, budget, result };
      }
      let guarded: ProtectResult;
      if (ticket?.type && ticket.noStop) {
        // No stop to keep: the order is left at the broker, as typed.
        const order = await current(this.broker, result.order!.id);
        guarded = { order, canceledQty: 0, stop: { pct: stopPct } };
      } else {
        progress({
          stage: !ticket?.type
            ? ticket?.noStop
              ? "watching the order"
              : "watching the order, keeping its stop"
            : `working: ${describeTicket(ticket)}${plan.offHours ? " from the open" : ""}, keeping a stop on fills`,
          orderId: result.order!.id,
        });
        // An order of the ticket's type is watched for as long as it can
        // fill: a day order until the close (off hours, the next one), a
        // GTC one until the contract expires.
        const waitMs =
          request.waitMs ??
          (!ticket?.type
            ? undefined
            : ticket.timeInForce === "gtc"
              ? Math.max(
                  limitWatchMs,
                  Date.parse(`${parseOccSymbol(symbol).expiry}T21:00:00Z`) -
                    this.now(),
                )
              : limitWatchMs);
        guarded = await protectFill(this.broker, result.order!, stopPct, {
          ...(waitMs === undefined ? {} : { waitMs }),
          ...(ticket?.noStop ? { noStop: true } : {}),
          ...this.timing,
        });
      }
      const order = guarded.order;
      const filled = order.filledQty > 0;
      const working = !finished.has(order.status);
      const final = {
        ...result,
        order,
        status:
          order.status === "filled"
            ? ("filled" as const)
            : guarded.cancelError || working
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
        ...(ticket?.noStop ? { noStop: true } : {}),
        ...(working ? { working: true } : {}),
      };
      if (!filled) return outcome;
      // A buy that adds to an open trade is posted under that trade's post.
      // A post left by a trade that is gone (more is not held than this
      // order bought) is not one.
      const known = await this.posts.get(symbol);
      // What is held of this contract now, for the post: how many, and what
      // share of the account they cost.
      const [held, equity] = await Promise.all([
        this.broker.position(symbol).catch(() => null),
        this.broker.equity().catch(() => 0),
      ]);
      const total = known && held ? held.qty : null;
      const cost = held
        ? held.qty * held.avgEntryPrice * 100
        : order.filledQty * (order.filledAvgPrice ?? 0) * 100;
      const sharePct =
        equity > 0 && cost > 0 ? (cost / equity) * 100 : undefined;
      const earlier =
        known && total !== null && total > order.filledQty ? known : undefined;
      const notes = [
        ...(plan.note ? [plan.note] : []),
        ...(plan.offHours ? ["Ordered off hours"] : []),
        ...(earlier ? [`Added to the position, ${total} held now`] : []),
      ];
      const post = await this.notifier.entry(
        {
          symbol,
          paper: this.paper,
          stop,
          ...(plan.tag ? { tag: plan.tag } : {}),
          ...(sharePct === undefined ? {} : { sharePct }),
          ...(notes.length > 0 ? { note: notes.join(". ") } : {}),
        },
        final,
        earlier,
      );
      if (post.ok && post.ref && !earlier)
        await this.posts.set(symbol, post.ref);
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
      order = await current(this.broker, order.id);
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
    await this.refuseLeg(symbol);
    const result = await sellAtBid(this.broker, symbol, request.qty, {
      ...(request.waitMs === undefined ? {} : { maxMs: request.waitMs }),
      stopPct: request.stopPct ?? defaultStopPct,
      ...this.timing,
    });
    const outcome = { paper: this.paper, symbol, result };
    if (!(result.sold > 0)) return outcome;
    const post = await this.notifier.exit(
      {
        symbol,
        paper: this.paper,
        ...(request.tag ? { tag: request.tag } : {}),
        ...(request.note ? { note: request.note } : {}),
      },
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
    // on the same contracts could sell them twice. A spread's long leg gets
    // none: selling it would leave the short leg bare.
    const legs = pairedQty(spreadPairs(await this.broker.positions()), symbol);
    const qty = uncovered(
      held.qty - legs,
      symbol,
      await this.broker.openOrders(symbol),
    );
    if (qty === 0)
      return {
        paper: this.paper,
        held: held.qty,
        note:
          legs > 0
            ? "a leg of a spread: it gets no stop"
            : "open sell orders already cover it",
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
   * Puts the position's stop at `price` (the site's "move stop"): one stop
   * for every held contract no other sell order covers. The price must be
   * below the bid, or the stop would sell at once, and not further below the
   * entry than the largest stop allowed.
   */
  async moveStop(request: { contract: string; price: number }) {
    const symbol = request.contract.toUpperCase();
    const held = await this.broker.position(symbol).catch(() => null);
    if (!held || !(held.qty > 0))
      throw new TradeRefusal("position", `no long position in ${symbol}`);
    await this.refuseLeg(symbol);
    if (!(request.price > 0))
      throw new TradeRefusal("stop", "the stop price must be above zero");
    const price = roundToTick(request.price, "up");
    const lowest = stopPrice(held.avgEntryPrice, this.limits.maxStopPct);
    if (price < lowest - 1e-9)
      throw new TradeRefusal(
        "stop",
        `${price.toFixed(2)} is more than ${this.limits.maxStopPct}% below the entry ${held.avgEntryPrice.toFixed(2)}; the lowest stop allowed is ${lowest.toFixed(2)}`,
      );
    const quote = await this.broker.quote(symbol);
    if (quote.bid > 0 && price >= quote.bid - 1e-9)
      throw new TradeRefusal(
        "stop",
        `${price.toFixed(2)} is at or above the bid ${quote.bid.toFixed(2)}: the stop would sell at once`,
        "Choose a price below the bid, or sell the position.",
      );
    const open = await this.broker.openOrders(symbol);
    const sells = open.filter((o) => o.side === "sell");
    if (sells.some((o) => o.stopPrice === null))
      throw new TradeRefusal(
        "stop",
        `a sale of ${symbol} is in progress; wait for it to end`,
      );
    const was =
      sells.length > 0 ? Math.min(...sells.map((o) => o.stopPrice!)) : null;
    const done = (qty: number) => ({
      paper: this.paper,
      contract: symbol,
      entry: held.avgEntryPrice,
      price,
      qty,
      was,
    });
    // One stop is changed in place: the position is never without it.
    if (sells.length === 1) {
      await this.broker.replaceStop(sells[0]!.id, held.qty, price);
      return done(held.qty);
    }
    const sleep =
      this.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (const stop of sells) await this.broker.cancel(stop.id);
    let free = held.qty;
    for (let i = 0; i < 10; i++) {
      free = uncovered(held.qty, symbol, await this.broker.openOrders(symbol));
      if (free === held.qty || sells.length === 0) break;
      await sleep(1000);
    }
    if (free === 0)
      throw new Error(
        "The old stops could not be taken off; they are still in place",
      );
    try {
      await this.broker.sellStop(symbol, free, price);
    } catch (error) {
      // The position must not be left bare: the old price goes back.
      if (was !== null)
        await this.broker.sellStop(symbol, free, was).catch(() => {});
      throw error;
    }
    return done(free);
  }

  /** The spread a held contract is a leg of, if any. */
  async spreadOf(symbol: string): Promise<SpreadPair | undefined> {
    const pairs = spreadPairs(await this.broker.positions());
    return pairs.find((p) => p.long === symbol || p.short === symbol);
  }

  /** Refuses an order on one leg of a spread alone. */
  private async refuseLeg(symbol: string) {
    const pair = await this.spreadOf(symbol);
    if (pair)
      throw new TradeRefusal(
        "spread",
        `${symbol} is a leg of a spread (buy ${pair.long}, sell ${pair.short}); selling or stopping one leg alone could leave the other short`,
        "Close the spread instead.",
      );
  }

  /** Both legs' quotes, the account, and the spread's size and checks. */
  private async assessSpread(request: SpreadRequest) {
    const longSymbol = request.long.toUpperCase();
    const shortSymbol = request.short.toUpperCase();
    if (request.sizePct === undefined && request.qty === undefined)
      throw new Error("Need a size: sizePct or qty");
    const [long, short, a] = await Promise.all([
      this.broker.quote(longSymbol),
      this.broker.quote(shortSymbol),
      this.account(),
    ]);
    const mid = (long.bid + long.ask - short.bid - short.ask) / 2;
    const natural = long.ask - short.bid;
    const limitPrice = Number(
      (
        request.limitPrice ?? Math.max(Math.round(mid * 100) / 100, 0.01)
      ).toFixed(2),
    );
    const { equity } = a.account;
    const perSpread = limitPrice * 100;
    const qty =
      request.qty ??
      (perSpread > 0 && equity > 0
        ? Math.floor((equity * request.sizePct!) / 100 / perSpread + 1e-9)
        : 0);
    // An exact number of spreads is measured as the share it can lose.
    const sizePct =
      request.qty !== undefined
        ? equity > 0
          ? Number(((request.qty * perSpread * 100) / equity).toFixed(4))
          : 0
        : request.sizePct!;
    const cost = qty * perSpread;
    const l = parseOccSymbol(longSymbol);
    const s = parseOccSymbol(shortSymbol);
    const daysToExpiry = Math.round(
      (Date.parse(`${l.expiry}T00:00:00Z`) - Date.parse(`${a.day}T00:00:00Z`)) /
        86400000,
    );
    const risk = checkRisk(
      {
        history: a.history,
        equity,
        todayLoss: a.account.lastEquity - equity,
        premium: cost,
        daysToExpiry,
      },
      this.riskRules,
    );
    const verdict = checkSpread(
      {
        now: a.now,
        enabled: this.enabled,
        paper: this.paper,
        shortRisks: a.shortRisks,
        marketOpen: a.marketOpen,
        equity,
        lastEquity: a.account.lastEquity,
        buyingPower: a.account.buyingPower,
        positions: a.held,
        buysToday: a.buysToday,
        working: a.working,
        risk,
        spread: { long, short, qty, limitPrice, sizePct },
      },
      this.limits,
    );
    if (!this.broker.spreadOrder) {
      const detail = `${this.broker.name} takes no multi-leg orders`;
      verdict.ok = false;
      verdict.checks.push({ check: "broker", ok: false, detail });
      verdict.refused.push(`broker: ${detail}`);
    }
    const width = Math.abs(l.strike - s.strike);
    return {
      a,
      qty,
      limitPrice,
      verdict,
      summary: {
        paper: this.paper,
        long: longSymbol,
        short: shortSymbol,
        underlying: l.underlying,
        right: l.right,
        expiry: l.expiry,
        longStrike: l.strike,
        shortStrike: s.strike,
        width,
        mid: Number(mid.toFixed(3)),
        natural: Number(natural.toFixed(2)),
        limitPrice,
        qty,
        sizePct,
        maxLoss: Number(cost.toFixed(2)),
        maxGain: Number(((width - limitPrice) * qty * 100).toFixed(2)),
        breakeven: Number(
          (l.right === "call"
            ? l.strike + limitPrice
            : l.strike - limitPrice
          ).toFixed(2),
        ),
        marketOpen: a.marketOpen,
        wouldBuy: verdict.ok,
        checks: verdict.checks,
        refused: verdict.refused,
        notes: verdict.notes,
      },
    };
  }

  /** What a debit spread would be now, with every check. Sends nothing. */
  async checkSpreadOrder(request: SpreadRequest) {
    return (await this.assessSpread(request)).summary;
  }

  /**
   * The checks of a spread. An accepted one is recorded as one of the day's
   * buys before its order goes out, like a single buy.
   */
  async planSpread(
    request: SpreadRequest,
  ): Promise<SpreadPlan | { paper: boolean; refused: string[] }> {
    const { a, qty, limitPrice, verdict, summary } =
      await this.assessSpread(request);
    if (!verdict.ok) return { paper: this.paper, refused: verdict.refused };
    const record = {
      id: `${a.now}-${summary.long}-spread`,
      day: a.day,
      symbol: summary.long,
      at: a.now,
      filled: null as boolean | null,
    };
    await this.buys.put(record);
    return {
      paper: this.paper,
      long: summary.long,
      short: summary.short,
      qty,
      limitPrice,
      maxLoss: summary.maxLoss,
      offHours: !a.marketOpen,
      notes: verdict.notes,
      record,
    };
  }

  /**
   * Sends the spread as one day limit order and watches it until it fills
   * or ends at the close. No stop: the debit is the most it can lose.
   */
  async runSpread(
    plan: SpreadPlan,
    progress: (p: BuyProgress) => void = () => {},
  ): Promise<SpreadDone> {
    let filled = false;
    try {
      const order = await this.workSpread(
        {
          legs: [
            { symbol: plan.long, side: "buy", intent: "buy_to_open" },
            { symbol: plan.short, side: "sell", intent: "sell_to_open" },
          ],
          qty: plan.qty,
          limitPrice: plan.limitPrice,
        },
        `buying at a net ${plan.limitPrice.toFixed(2)}${plan.offHours ? " from the open" : ""}`,
        progress,
      );
      filled = order.filledQty > 0;
      const done: SpreadDone = {
        paper: this.paper,
        long: plan.long,
        short: plan.short,
        qty: plan.qty,
        limitPrice: plan.limitPrice,
        order,
      };
      if (!filled) return done;
      const paid = order.filledAvgPrice ?? plan.limitPrice;
      const post = await this.notifier
        .notice(`Spread bought${this.paper ? " (paper)" : ""}`, [
          spreadName(plan.long, plan.short),
          `${order.filledQty} at a net ${paid.toFixed(2)}`,
          `At most $${Math.round(paid * order.filledQty * 100)} at risk; no stop`,
        ])
        .catch(() => undefined);
      return { ...done, ...(post ? { post } : {}) };
    } finally {
      // A spread that bought nothing does not use up one of the day's buys.
      await this.buys.put({ ...plan.record, filled });
    }
  }

  /** What a close would send; refuses one that does not match a held spread. */
  async planClose(request: SpreadCloseRequest) {
    const long = request.long.toUpperCase();
    const short = request.short.toUpperCase();
    if (!this.broker.spreadOrder)
      throw new TradeRefusal(
        "broker",
        `${this.broker.name} takes no multi-leg orders`,
      );
    const held = spreadPairs(await this.broker.positions())
      .filter((p) => p.long === long && p.short === short)
      .reduce((sum, p) => sum + p.qty, 0);
    if (held === 0)
      throw new TradeRefusal(
        "spread",
        `no spread of long ${long} and short ${short} is held`,
      );
    const qty = request.qty ?? held;
    if (!(Number.isInteger(qty) && qty >= 1 && qty <= held))
      throw new TradeRefusal(
        "spread",
        `${qty} is not a number of spreads from 1 to the ${held} held`,
      );
    const [l, s] = await Promise.all([
      this.broker.quote(long),
      this.broker.quote(short),
    ]);
    const mid = (l.bid + l.ask - s.bid - s.ask) / 2;
    const credit = Number(
      (request.limitPrice ?? Math.max(Math.round(mid * 100) / 100, 0)).toFixed(
        2,
      ),
    );
    if (!(credit >= 0))
      throw new TradeRefusal("price", "the credit must be zero or more");
    return {
      paper: this.paper,
      long,
      short,
      qty,
      held,
      credit,
      mid: Number(mid.toFixed(3)),
      natural: Number((l.bid - s.ask).toFixed(2)),
    };
  }

  /**
   * Closes a held spread with one order: sell the long leg and buy back the
   * short one, for a net credit. Not subject to the buy checks, like a sale.
   */
  async closeSpread(
    plan: Awaited<ReturnType<TradeEngine["planClose"]>>,
    progress: (p: BuyProgress) => void = () => {},
  ): Promise<SpreadDone> {
    const order = await this.workSpread(
      {
        legs: [
          { symbol: plan.long, side: "sell", intent: "sell_to_close" },
          { symbol: plan.short, side: "buy", intent: "buy_to_close" },
        ],
        qty: plan.qty,
        // Received: a negative net price.
        limitPrice: -plan.credit,
      },
      `closing for a net ${plan.credit.toFixed(2)}`,
      progress,
    );
    const done: SpreadDone = {
      paper: this.paper,
      long: plan.long,
      short: plan.short,
      qty: plan.qty,
      limitPrice: -plan.credit,
      order,
    };
    if (!(order.filledQty > 0)) return done;
    const post = await this.notifier
      .notice(`Spread closed${this.paper ? " (paper)" : ""}`, [
        spreadName(plan.long, plan.short),
        `${order.filledQty} for a net ${Math.abs(order.filledAvgPrice ?? -plan.credit).toFixed(2)}`,
      ])
      .catch(() => undefined);
    return { ...done, ...(post ? { post } : {}) };
  }

  /** One multi-leg day order, watched until it fills or ends. */
  private async workSpread(
    ticket: SpreadTicket,
    stage: string,
    progress: (p: BuyProgress) => void,
  ): Promise<Order> {
    const sleep =
      this.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let order = await this.broker.spreadOrder!(ticket);
    this.log(
      `spread ${ticket.legs.map((l) => `${l.side} ${l.symbol}`).join(" / ")} ${ticket.qty} @ ${ticket.limitPrice.toFixed(2)}`,
    );
    progress({ stage, orderId: order.id });
    const pollMs = 3000;
    for (
      let waited = 0;
      !finished.has(order.status) && waited < limitWatchMs;
      waited += pollMs
    ) {
      await sleep(pollMs);
      order = await current(this.broker, order.id);
    }
    return order;
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
        maxSizePct: this.limits.maxSizePct,
        maxOpenRiskPct: this.limits.maxOpenRiskPct,
        maxDayLossPct: this.limits.maxDayLossPct,
        maxPositionPct: this.limits.maxPositionPct,
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
    // Stocks too: the site sells shares (user 2026-10-16), never short.
    const problems = shortRisks(
      [
        ...(await this.broker.positions()),
        ...((await this.broker.stockPositions?.()) ?? []),
      ],
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
