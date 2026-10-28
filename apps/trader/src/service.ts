import { randomUUID } from "node:crypto";
import { optionTicket } from "../../../packages/trading/src/option-tickets.js";
import type { Broker } from "../../../packages/trading/src/broker.js";
import {
  TradeRefusal,
  type BuyProgress,
  type BuyRequest,
  type PostStore,
  type SpreadRequest,
  type TradeEngine,
} from "../../../packages/trading/src/engine.js";
import { exitQty } from "../../../packages/trading/src/exit.js";
import {
  parseOccSymbol,
  roundToTick,
} from "../../../packages/trading/src/options.js";
import type { Notifier } from "../../../packages/trading/src/notifier.js";
import {
  sellableShares,
  sharesFor,
  stockSellQty,
  stockStepPrice,
  workStockOrder,
} from "../../../packages/trading/src/stock-orders.js";
import {
  stockChange,
  stockTicket,
  TicketError,
} from "../../../packages/trading/src/stock-tickets.js";
import type { JobKind, TradeStore } from "./store.js";

// The trading service behind the Claude connector
// (docs/tasks/backend-trading-service.md). A buy or a sell answers at once
// and runs as a job; every step that matters is in the store, so a restart
// cannot leave an order working or a filled contract without a stop.

/** A request the caller got wrong; answered with its message. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface TraderOptions {
  userId: string;
  store: TradeStore;
  engine: TradeEngine;
  broker: Broker;
  notifier: Notifier;
  // The post of each open trade; a stop-out is attached to it.
  posts?: PostStore;
  now?: () => number;
  log?: (line: string) => void;
  // Waits between a stock order's price moves; real time when absent.
  sleep?: (ms: number) => Promise<void>;
}

/** The stop orders seen open at the last look, and each position's entry. */
interface StopWatch {
  stops: Record<
    string,
    { symbol: string; stopPrice: number | null; tries?: number }
  >;
  entries: Record<string, number>;
}
// A stop-out that could not be posted is tried again this many times.
const postTries = 5;

type Body = Record<string, unknown>;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function text(body: Body, name: string, pattern: RegExp): string | undefined {
  const value = body[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !pattern.test(value))
    throw new RequestError(`${name} is not valid`);
  return value;
}
function number(body: Body, name: string): number | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new RequestError(`${name} must be a number`);
  return value;
}

const ticker = /^[A-Za-z][A-Za-z.]{0,5}$/;
const occ = /^[A-Za-z]{1,6}\d{6}[CPcp]\d{8}$/;

/** What to buy: one contract, or an underlying with call or put. */
function buyRequest(body: Body): BuyRequest {
  const contract = text(body, "contract", occ);
  const underlying = text(body, "underlying", ticker);
  const right = text(body, "right", /^(call|put)$/) as
    "call" | "put" | undefined;
  if (!contract && !(underlying && right))
    throw new RequestError("Need underlying and right (call or put)");
  const sizePct = number(body, "sizePct");
  const qty = number(body, "qty");
  if (qty !== undefined && !(Number.isInteger(qty) && qty >= 1))
    throw new RequestError("qty must be a whole number of contracts");
  if (qty !== undefined && !contract)
    throw new RequestError("qty needs a contract; otherwise give sizePct");
  if (sizePct !== undefined && qty !== undefined)
    throw new RequestError("sizePct and qty cannot be combined");
  if (sizePct === undefined && qty === undefined)
    throw new RequestError("Need sizePct");
  const expiry = text(body, "expiry", /^(nearest|friday|\d{4}-\d{2}-\d{2})$/);
  const delta = number(body, "delta");
  const strike = number(body, "strike");
  if (strike !== undefined && !(strike > 0))
    throw new RequestError("strike must be greater than zero");
  if (strike !== undefined && delta !== undefined)
    throw new RequestError("strike and delta cannot be combined");
  if (contract && strike !== undefined)
    throw new RequestError("strike cannot be combined with contract");
  const stopPct = number(body, "stopPct");
  const limitPrice = number(body, "limitPrice");
  const stopPrice = number(body, "stopPrice");
  const orderType = text(body, "orderType", /^[a-z_]{1,16}$/);
  const timeInForce = text(body, "timeInForce", /^[a-z]{1,8}$/);
  if (body.autoStop !== undefined && typeof body.autoStop !== "boolean")
    throw new RequestError("autoStop must be true or false");
  // The ticket's order (option-tickets.ts): types, prices on the tick.
  const ticket = {
    ...(orderType === undefined ? {} : { orderType }),
    ...(limitPrice === undefined ? {} : { limitPrice }),
    ...(stopPrice === undefined ? {} : { stopPrice }),
    ...(timeInForce === undefined ? {} : { timeInForce }),
    ...(body.autoStop === false ? { autoStop: false } : {}),
  };
  try {
    optionTicket(ticket);
  } catch (error) {
    throw new RequestError(message(error));
  }
  if (Object.keys(ticket).length > 0 && !contract)
    throw new RequestError("An order type or price needs a contract");
  if (body.force !== undefined && typeof body.force !== "boolean")
    throw new RequestError("force must be true or false");
  if (body.chase !== undefined && typeof body.chase !== "boolean")
    throw new RequestError("chase must be true or false");
  const chaseMs = number(body, "chaseMs");
  if (chaseMs !== undefined && !(chaseMs >= 1000 && chaseMs <= 3_600_000))
    throw new RequestError("chaseMs must be 1000–3600000");
  return {
    ...(body.force === true ? { force: true } : {}),
    ...(body.chase === true ? { chase: true } : {}),
    ...(chaseMs === undefined ? {} : { chaseMs }),
    ...(contract ? { contract } : { underlying: underlying!, right: right! }),
    ...(qty === undefined ? { sizePct: sizePct! } : { qty }),
    ...(expiry ? { expiry } : {}),
    ...(delta === undefined ? {} : { delta }),
    ...(strike === undefined ? {} : { strike }),
    ...(stopPct === undefined ? {} : { stopPct }),
    ...ticket,
    ...postLines(body),
  };
}

// The bot's first line and reason for the posts (docs/tasks/backend-indi-bot.md).
function postLines(body: Body): { tag?: string; note?: string } {
  const tag = text(body, "tag", /^[^<>\n]{1,40}$/u);
  const note = text(body, "note", /^[^<>\n]{1,200}$/u);
  return {
    ...(tag === undefined ? {} : { tag }),
    ...(note === undefined ? {} : { note }),
  };
}

/** A spread's two legs, its size and its net price, from a request. */
function spreadRequest(body: Body, close = false): SpreadRequest {
  const long = text(body, "long", occ)?.toUpperCase();
  const short = text(body, "short", occ)?.toUpperCase();
  if (!long || !short)
    throw new RequestError("Need long and short: the two contracts");
  if (long === short)
    throw new RequestError("long and short must be different contracts");
  const sizePct = number(body, "sizePct");
  const qty = number(body, "qty");
  if (qty !== undefined && !(Number.isInteger(qty) && qty >= 1))
    throw new RequestError("qty must be a whole number of spreads");
  if (sizePct !== undefined && qty !== undefined)
    throw new RequestError("sizePct and qty cannot be combined");
  if (!close && sizePct === undefined && qty === undefined)
    throw new RequestError("Need a size: sizePct or qty");
  const limitPrice = number(body, "limitPrice");
  if (
    limitPrice !== undefined &&
    !(
      limitPrice >= 0 &&
      Math.abs(limitPrice * 100 - Math.round(limitPrice * 100)) < 1e-6
    )
  )
    throw new RequestError("limitPrice must be 0 or more, in cents");
  return {
    long,
    short,
    ...(qty === undefined ? {} : { qty }),
    ...(sizePct === undefined ? {} : { sizePct }),
    ...(limitPrice === undefined ? {} : { limitPrice }),
  };
}

export class TraderService {
  private readonly userId: string;
  private readonly store: TradeStore;
  private readonly engine: TradeEngine;
  private readonly broker: Broker;
  private readonly notifier: Notifier;
  private readonly posts: PostStore | undefined;
  private watching = false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly running = new Map<string, Promise<void>>();
  // Where each running job stands; lost on a restart, like the job itself.
  private readonly progress = new Map<string, BuyProgress>();

  constructor(options: TraderOptions) {
    this.userId = options.userId;
    this.store = options.store;
    this.engine = options.engine;
    this.broker = options.broker;
    this.notifier = options.notifier;
    this.posts = options.posts;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.sleep = options.sleep;
  }

  private record(tool: string, input: unknown, outcome: string) {
    this.store.log(this.now(), this.userId, tool, input, outcome);
  }

  /** Runs `work` as a job and stores how it ended. */
  private start(
    kind: JobKind,
    symbol: string,
    request: unknown,
    work: (id: string) => Promise<object>,
  ): string {
    const id = randomUUID();
    this.store.createJob(
      { id, userId: this.userId, kind, symbol, request },
      this.now(),
    );
    const run = (async () => {
      try {
        const outcome = await work(id);
        // Whatever the order did, look at the account.
        const { problems } = await this.engine.shortCheck().catch((error) => ({
          problems: [`the short check failed: ${message(error)}`],
        }));
        this.store.finishJob(
          id,
          "done",
          { ...outcome, shortRisks: problems },
          this.now(),
        );
      } catch (error) {
        this.log(`job ${id} failed: ${message(error)}`);
        this.store.finishJob(
          id,
          "failed",
          { error: message(error) },
          this.now(),
        );
      } finally {
        this.running.delete(id);
        this.progress.delete(id);
        // The job may have placed or moved a stop: have it watched from now.
        await this.watchStops().catch(() => {});
      }
    })();
    this.running.set(id, run);
    return id;
  }

  /** Resolves once no job is running (tests, shutdown). */
  async idle() {
    while (this.running.size > 0) await Promise.all(this.running.values());
  }

  async preview(body: Body) {
    const request = buyRequest(body);
    if (!request.underlying || !request.right)
      throw new RequestError("A preview needs underlying and right");
    if (request.sizePct === undefined)
      throw new RequestError("A preview needs sizePct");
    const result = await this.engine
      .preview({
        underlying: request.underlying,
        right: request.right,
        sizePct: request.sizePct,
        ...(request.expiry === undefined ? {} : { expiry: request.expiry }),
        ...(request.force ? { force: true } : {}),
        ...(request.delta === undefined ? {} : { delta: request.delta }),
        ...(request.strike === undefined ? {} : { strike: request.strike }),
        ...(request.stopPct === undefined ? {} : { stopPct: request.stopPct }),
      })
      .catch((error: unknown) => {
        if (error instanceof TradeRefusal)
          throw new RequestError(
            [error.message, error.hint].filter(Boolean).join(". "),
            422,
          );
        throw error;
      });
    this.record("preview", body, "ok");
    return result;
  }

  /** One side of a stock's chain for one expiry, to pick a strike from. */
  async chain(query: Body) {
    const underlying = text(query, "underlying", ticker);
    const right = text(query, "right", /^(call|put)$/) as
      "call" | "put" | undefined;
    if (!underlying || !right)
      throw new RequestError("Need underlying and right (call or put)");
    const expiry = text(query, "expiry", /^\d{4}-\d{2}-\d{2}$/);
    return this.engine
      .chainFor({ underlying, right, ...(expiry ? { expiry } : {}) })
      .catch((error: unknown) => {
        if (error instanceof TradeRefusal)
          throw new RequestError(
            [error.detail, error.hint].filter(Boolean).join(". "),
            404,
          );
        throw error;
      });
  }

  /** What a buy of one contract would be, and each check. Sends nothing. */
  async check(body: Body) {
    const request = buyRequest(body);
    if (!request.contract) throw new RequestError("A check needs a contract");
    return this.engine.checkContract({
      contract: request.contract,
      ...(request.qty === undefined
        ? { sizePct: request.sizePct! }
        : { qty: request.qty }),
      ...(request.stopPct === undefined ? {} : { stopPct: request.stopPct }),
      ...(request.force ? { force: true } : {}),
      ...(request.limitPrice === undefined
        ? {}
        : { limitPrice: request.limitPrice }),
      ...(request.orderType === undefined
        ? {}
        : { orderType: request.orderType }),
      ...(request.stopPrice === undefined
        ? {}
        : { stopPrice: request.stopPrice }),
      ...(request.timeInForce === undefined
        ? {}
        : { timeInForce: request.timeInForce }),
      ...(request.autoStop === false ? { autoStop: false } : {}),
    });
  }

  /**
   * Checks the buy and, when it passes, starts it. Answers at once.
   * `options.repeatOk` is the bot's in-process add to its own position (the
   * pyramid): never read from the body, so no request can set it.
   */
  async buy(body: Body, options: { repeatOk?: boolean } = {}) {
    const request = {
      ...buyRequest(body),
      ...(options.repeatOk ? { repeatOk: true } : {}),
    };
    let plan;
    try {
      plan = await this.engine.planBuy(request);
    } catch (error) {
      // Nothing could be picked: answered like any refused buy, with the
      // reason and what would work instead.
      if (error instanceof TradeRefusal) {
        this.record("buy", body, `refused: ${error.message}`);
        return {
          status: "refused" as const,
          paper: this.broker.capabilities.paper,
          contract: null,
          qty: 0,
          refused: [error.message],
          ...(error.hint ? { hint: error.hint } : {}),
        };
      }
      if (
        request.strike !== undefined &&
        message(error).startsWith("No contract at strike ")
      )
        throw new RequestError(message(error));
      throw error;
    }
    if ("refused" in plan) {
      this.record("buy", body, `refused: ${plan.refused.join("; ")}`);
      return { status: "refused" as const, ...plan };
    }
    const jobId = this.start("buy", plan.contract, request, (id) =>
      this.engine.runBuy(plan, (p) => this.progress.set(id, p)),
    );
    this.record("buy", body, `started ${jobId}: ${plan.qty} ${plan.contract}`);
    return {
      status: "started" as const,
      jobId,
      paper: plan.paper,
      contract: plan.contract,
      qty: plan.qty,
      budget: plan.budget,
      stopPct: plan.stopPct,
      offHours: plan.offHours,
      notes: plan.notes,
    };
  }

  private async target(body: Body) {
    const contract = text(body, "contract", occ);
    const underlying = text(body, "underlying", ticker);
    try {
      const symbol = await this.engine.sellTarget({
        ...(contract ? { contract } : {}),
        ...(underlying ? { underlying } : {}),
      });
      const held = await this.broker.position(symbol).catch(() => null);
      if (!held || !(held.qty > 0))
        throw new Error(`No long position in ${symbol}`);
      // One leg of a spread is never sold, resized or stopped alone.
      const pair = await this.engine.spreadOf(symbol);
      if (pair)
        throw new Error(
          `${symbol} is a leg of a spread (buy ${pair.long}, sell ${pair.short}); close the spread instead`,
        );
      return { symbol, held };
    } catch (error) {
      throw new RequestError(message(error));
    }
  }

  /** Starts a sale at the bid. Answers at once. */
  async sell(body: Body) {
    const { symbol, held } = await this.target(body);
    const qty = text(body, "qty", /^(all|half|\d{1,5})$/);
    if (!qty) throw new RequestError("Need qty: all, half or a number");
    let asked: number;
    try {
      asked = exitQty(qty, held.qty);
    } catch (error) {
      throw new RequestError(message(error));
    }
    if (this.store.runningJobs(this.userId).some((j) => j.symbol === symbol))
      throw new RequestError(
        `${symbol} already has an order in progress; wait for it`,
        409,
      );
    const stopPct = number(body, "stopPct");
    // How long the sale is re-priced at the bid before giving up (the bot
    // asks for 10 minutes; the default is 2).
    const waitMs = number(body, "waitMs");
    if (waitMs !== undefined && !(waitMs >= 1000 && waitMs <= 3_600_000))
      throw new RequestError("waitMs must be 1000–3600000");
    const request = {
      contract: symbol,
      qty,
      ...(stopPct === undefined ? {} : { stopPct }),
      ...(waitMs === undefined ? {} : { waitMs }),
      ...postLines(body),
    };
    const jobId = this.start("sell", symbol, request, () =>
      this.engine.sell(request),
    );
    this.record(
      "sell",
      body,
      `started ${jobId}: ${asked} of ${held.qty} ${symbol}`,
    );
    return {
      status: "started" as const,
      jobId,
      contract: symbol,
      selling: asked,
      held: held.qty,
    };
  }

  /**
   * Brings a position to `qty` contracts: sells the difference at the bid, or
   * buys it as an addition that every buy check must pass. Zero sells all.
   */
  async resize(body: Body) {
    const { symbol, held } = await this.target(body);
    const wanted = number(body, "qty");
    if (wanted === undefined || !Number.isInteger(wanted) || wanted < 0)
      throw new RequestError(
        "qty must be a whole number of contracts, 0 or more",
      );
    if (wanted === held.qty)
      throw new RequestError(`${symbol} already holds ${held.qty}`, 409);
    if (wanted < held.qty)
      return this.sell({
        contract: symbol,
        qty: wanted === 0 ? "all" : String(held.qty - wanted),
      });
    if (this.store.runningJobs(this.userId).some((j) => j.symbol === symbol))
      throw new RequestError(
        `${symbol} already has an order in progress; wait for it`,
        409,
      );
    const stopPct = number(body, "stopPct");
    return this.buy({
      contract: symbol,
      qty: wanted - held.qty,
      ...(stopPct === undefined ? {} : { stopPct }),
    });
  }

  /**
   * One look at the stop orders (user 2026-10-12: a stop that sells must be
   * reported). A stop seen open at the last look and gone now is read back
   * from the broker; if it sold contracts, the channel is told, under the
   * trade's post. What was seen is kept in the store, so a stop that fills
   * while the service is down is reported when it is back. Returns how many
   * stop-outs were handled.
   */
  async watchStops(): Promise<number> {
    if (this.watching) return 0;
    this.watching = true;
    try {
      const last = this.store.note<StopWatch>(this.userId, "stop-watch") ?? {
        stops: {},
        entries: {},
      };
      const [open, positions] = await Promise.all([
        this.broker.openOrders(),
        this.broker.positions(),
      ]);
      // Option stops only: stock stops are the user's own orders, with no
      // trade post to report under (user 2026-10-16).
      const stops = open.filter(
        (o) => o.side === "sell" && o.stopPrice !== null && occ.test(o.symbol),
      );
      const stillOpen = new Set(stops.map((o) => o.id));
      const held = new Map(positions.map((p) => [p.symbol, p]));
      const next: StopWatch = { stops: {}, entries: {} };
      let handled = 0;
      for (const [id, seen] of Object.entries(last.stops)) {
        if (stillOpen.has(id)) continue;
        const tries = (seen.tries ?? 0) + 1;
        const retry = () => {
          if (tries < postTries) next.stops[id] = { ...seen, tries };
          return tries < postTries;
        };
        const order = await this.broker.order(id).catch(() => null);
        if (!order) {
          if (!retry()) this.log(`stop watch: order ${id} cannot be read`);
          continue;
        }
        // Canceled, replaced or expired with nothing sold: not a stop-out.
        if (!(order.filledQty > 0)) continue;
        const fill = {
          symbol: seen.symbol,
          sold: order.filledQty,
          price: order.filledAvgPrice ?? seen.stopPrice ?? 0,
          stopPrice: seen.stopPrice,
          entry: last.entries[seen.symbol] ?? null,
          remaining: Math.max(held.get(seen.symbol)?.qty ?? 0, 0),
        };
        const sent = await this.notifier
          .stopped(
            { symbol: seen.symbol, paper: this.broker.capabilities.paper },
            fill,
            await this.posts?.get(seen.symbol),
          )
          .catch((error: unknown) => ({
            ok: false as const,
            error: message(error),
          }));
        if (!sent.ok && retry()) continue;
        this.record(
          "stop-out",
          { orderId: id, ...fill },
          sent.ok
            ? `posted${sent.commentError ? `, comment failed: ${sent.commentError}` : ""}`
            : `NOT posted: ${sent.error}`,
        );
        this.log(
          `stop-out: ${fill.sold} ${fill.symbol} at ${fill.price.toFixed(2)}`,
        );
        if (fill.remaining === 0) await this.posts?.set(seen.symbol, null);
        handled++;
      }
      for (const o of stops)
        next.stops[o.id] = { symbol: o.symbol, stopPrice: o.stopPrice };
      for (const p of positions)
        if (p.qty > 0) next.entries[p.symbol] = p.avgEntryPrice;
      // The entry of a stop-out still to be posted is kept until it is.
      for (const seen of Object.values(next.stops))
        if (next.entries[seen.symbol] === undefined) {
          const entry = last.entries[seen.symbol];
          if (entry !== undefined) next.entries[seen.symbol] = entry;
        }
      this.store.setNote(this.userId, "stop-watch", next);
      return handled;
    } finally {
      this.watching = false;
    }
  }

  /** Moves the position's stop to a price. */
  async moveStop(body: Body) {
    const { symbol } = await this.target(body);
    const price = number(body, "price");
    if (price === undefined) throw new RequestError("Need price");
    if (this.store.runningJobs(this.userId).some((j) => j.symbol === symbol))
      throw new RequestError(
        `${symbol} has an order in progress; wait for it`,
        409,
      );
    let result;
    try {
      result = await this.engine.moveStop({ contract: symbol, price });
    } catch (error) {
      this.record("move-stop", body, `failed: ${message(error)}`);
      if (error instanceof TradeRefusal)
        throw new RequestError(
          [error.detail, error.hint].filter(Boolean).join(". "),
          422,
        );
      throw error;
    }
    const { problems } = await this.engine.shortCheck();
    this.record(
      "move-stop",
      body,
      `${result.qty} ${symbol} at ${result.price.toFixed(2)}`,
    );
    // The new stop is the one watched from now on.
    await this.watchStops().catch(() => {});
    const c = parseOccSymbol(symbol);
    const post = await this.notifier
      .notice(`Stop moved${result.paper ? " (paper)" : ""}`, [
        `$${c.underlying} | ${c.strike} ${c.right === "call" ? "Call" : "Put"} ${c.expiry}`,
        `Stop at ${result.price.toFixed(2)} on ${result.qty}${result.was === null ? "" : `, was ${result.was.toFixed(2)}`}`,
        `Entry ${result.entry.toFixed(2)}`,
      ])
      .catch(() => null);
    return { ...result, shortRisks: problems, posted: post?.ok === true };
  }

  /** One open option order of the account, by its id at the broker. */
  private async openOrder(id: unknown) {
    if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id))
      throw new RequestError("orderId is not valid");
    const order = (await this.broker.openOrders()).find((o) => o.id === id);
    if (!order) throw new RequestError("No open order with that id", 404);
    return order;
  }

  /**
   * Withdraws one open order (the site's "cancel"). A buy's job then ends on
   * its own, with whatever filled covered by a stop. Canceling a stop leaves
   * its contracts without one; that is said in the answer.
   */
  async cancelOrder(body: Body) {
    const order = await this.openOrder(body.orderId);
    try {
      await this.broker.cancel(order.id);
    } catch (error) {
      throw new RequestError(message(error), 502);
    }
    const left = order.qty - order.filledQty;
    const kind =
      order.stopPrice !== null ? "stop" : order.side === "buy" ? "buy" : "sell";
    this.record(
      "cancel-order",
      body,
      `canceled ${kind} ${left} ${order.symbol}`,
    );
    if (kind === "stop" && occ.test(order.symbol)) {
      const c = parseOccSymbol(order.symbol);
      await this.notifier
        .alert(
          `Stop canceled${this.broker.capabilities.paper ? " (paper)" : ""}`,
          [
            `$${c.underlying} | ${c.strike} ${c.right === "call" ? "Call" : "Put"} ${c.expiry}`,
            `${left} contract${left === 1 ? "" : "s"} now have no stop.`,
          ],
        )
        .catch(() => {});
    }
    return {
      canceled: `${left} ${order.symbol}`,
      kind,
      ...(kind === "stop"
        ? { warning: `${left} ${order.symbol} now have no stop` }
        : {}),
    };
  }

  /**
   * Changes the limit price of a buy that is waiting or working (the site's
   * "change price"). Not above the ask, and the order may not cost more than
   * the largest size allowed. The job that owns the order follows it.
   */
  async repriceOrder(body: Body) {
    const order = await this.openOrder(body.orderId);
    const asked = number(body, "price");
    if (asked === undefined || !(asked > 0))
      throw new RequestError("price must be above zero");
    if (
      order.stopPrice !== null ||
      (order.side !== "buy" && occ.test(order.symbol))
    )
      throw new RequestError(
        "Only a buy order's price can be changed here; a stop is moved on its position",
        409,
      );
    // While the service raises the price itself, two changes would collide.
    if (!occ.test(order.symbol)) return this.repriceStock(order, asked, body);
    const raising = this.store
      .runningJobs(this.userId)
      .some(
        (j) =>
          j.symbol === order.symbol &&
          this.progress.get(j.id)?.stage === "raising the price",
      );
    if (raising)
      throw new RequestError(
        "The service is raising this order's price right now; try again in a few seconds",
        409,
      );
    const price = roundToTick(asked, "down");
    let quote;
    let status;
    try {
      [quote, status] = await Promise.all([
        this.broker.quote(order.symbol),
        this.engine.status(),
      ]);
    } catch (error) {
      throw new RequestError(message(error), 502);
    }
    if (quote.ask > 0 && price > quote.ask + 1e-9)
      throw new RequestError(
        `${price.toFixed(2)} is above the ask ${quote.ask.toFixed(2)}`,
        422,
      );
    const cost = price * order.qty * 100;
    const most = (status.equity * status.limits.maxSizePct) / 100;
    if (cost > most + 1e-9)
      throw new RequestError(
        `${order.qty} at ${price.toFixed(2)} costs $${Math.round(cost).toLocaleString("en-US")}, more than ${status.limits.maxSizePct}% of the account ($${Math.round(most).toLocaleString("en-US")})`,
        422,
      );
    let changed;
    try {
      changed = await this.broker.replace(order.id, price);
    } catch (error) {
      throw new RequestError(message(error), 502);
    }
    this.record(
      "reprice-order",
      body,
      `${order.symbol} ${order.limitPrice?.toFixed(2) ?? "?"} -> ${price.toFixed(2)}`,
    );
    return {
      contract: order.symbol,
      orderId: changed.id,
      price,
      was: order.limitPrice,
      qty: order.qty,
    };
  }

  /** Puts a stop on held contracts that have none. */
  async stop(body: Body) {
    const { symbol } = await this.target(body);
    const stopPct = number(body, "stopPct");
    let result: object;
    try {
      result = await this.engine.setStop({
        contract: symbol,
        ...(stopPct === undefined ? {} : { stopPct }),
      });
    } catch (error) {
      this.record("stop", body, `failed: ${message(error)}`);
      throw new RequestError(message(error));
    }
    const { problems } = await this.engine.shortCheck();
    this.record("stop", body, "ok");
    return { contract: symbol, ...result, shortRisks: problems };
  }

  job(id: string) {
    const job = this.store.job(this.userId, id);
    if (!job) throw new RequestError("No such job", 404);
    return {
      jobId: job.id,
      kind: job.kind,
      contract: job.symbol,
      state: job.state,
      ...(this.progress.has(id) ? { stage: this.progress.get(id)!.stage } : {}),
      result: job.result,
      startedAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
    };
  }

  /**
   * Withdraws a buy that is still working at the broker, such as an order
   * waiting for the open. It is named by its job, or by the stock or contract
   * when exactly that is known. The job then ends on its own, with whatever
   * filled covered by a stop. Open buy orders that no running job owns (after
   * a restart) are withdrawn too.
   */
  async cancel(body: Body) {
    const jobId = text(body, "jobId", /^[\w-]{1,64}$/);
    const contract = text(body, "contract", occ)?.toUpperCase();
    const underlying = text(body, "underlying", ticker)?.toUpperCase();
    if (!jobId && !contract && !underlying)
      throw new RequestError("Need jobId, underlying or contract");
    const matches = (symbol: string) =>
      contract
        ? symbol === contract
        : parseOccSymbol(symbol).underlying === underlying;
    if (jobId) {
      const job = this.store.job(this.userId, jobId);
      if (!job) throw new RequestError("No such job", 404);
      if (job.state !== "running")
        throw new RequestError(`This order is already ${job.state}`, 409);
    }
    const jobs = this.store
      .runningJobs(this.userId)
      .filter(
        (j) =>
          j.userId === this.userId &&
          j.kind === "buy" &&
          (jobId ? j.id === jobId : matches(j.symbol)),
      );
    const canceled: string[] = [];
    try {
      const ids = new Set(
        jobs.flatMap((j) => this.progress.get(j.id)?.orderId ?? []),
      );
      // Also any open buy order of that contract the broker still holds.
      const symbols = new Set(jobs.map((j) => j.symbol));
      const open = (await this.broker.openOrders()).filter(
        (o) =>
          o.side === "buy" &&
          (ids.has(o.id) ||
            symbols.has(o.symbol) ||
            (!jobId && matches(o.symbol))),
      );
      for (const order of open) {
        await this.broker.cancel(order.id);
        canceled.push(`${order.qty - order.filledQty} ${order.symbol}`);
      }
    } catch (error) {
      throw new RequestError(message(error), 502);
    }
    if (canceled.length === 0)
      throw new RequestError(
        jobs.length > 0
          ? "This order cannot be canceled at this stage"
          : "No waiting or working buy order was found for that",
        409,
      );
    this.record("cancel", body, `canceled ${canceled.join(", ")}`);
    return { canceled, jobIds: jobs.map((j) => j.id) };
  }

  /** Every recent buy command with the reasons behind it, newest first. */
  decisions(limit = 50) {
    return {
      decisions: this.store.recentDecisions(
        this.userId,
        Math.min(Math.max(Math.trunc(limit) || 50, 1), 200),
      ),
    };
  }

  /** Positions and limits, plus the orders that are waiting or working. */
  async status() {
    const [status, open] = await Promise.all([
      this.engine.status(),
      this.broker.openOrders(),
    ]);
    return {
      ...status,
      workingOrders: this.store
        .runningJobs(this.userId)
        .filter((j) => j.userId === this.userId)
        .map((j) => ({
          jobId: j.id,
          kind: j.kind,
          contract: j.symbol,
          stage: this.progress.get(j.id)?.stage ?? "running",
          startedAt: new Date(j.createdAt).toISOString(),
        })),
      openOrders: open.map((o) => ({
        contract: o.symbol,
        side: o.side,
        type: o.type ?? (o.stopPrice === null ? "limit" : "stop"),
        ...(o.timeInForce ? { timeInForce: o.timeInForce } : {}),
        qty: o.qty,
        filledQty: o.filledQty,
        price: o.stopPrice ?? o.limitPrice,
        limitPrice: o.limitPrice,
        stopPrice: o.stopPrice,
        status: o.status,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Stocks (user 2026-10-16): bought and sold from the site only, whole
  // shares, long only. No size limit and no automatic stop, by the user's
  // choice; a sell never goes beyond the shares held.

  private stockBroker() {
    const { stockQuote, stockLimit, stockPositions } = this.broker;
    if (!stockQuote || !stockLimit || !stockPositions)
      throw new RequestError("This broker cannot trade stocks", 501);
    return {
      stockQuote: stockQuote.bind(this.broker),
      stockLimit: stockLimit.bind(this.broker),
      stockPositions: stockPositions.bind(this.broker),
      replace: this.broker.replace.bind(this.broker),
      order: this.broker.order.bind(this.broker),
    };
  }

  private stockSymbol(source: Body) {
    const symbol = text(source, "symbol", ticker);
    if (!symbol) throw new RequestError("symbol must be a stock ticker");
    return symbol.toUpperCase();
  }

  private async heldShares(symbol: string) {
    const positions = await this.stockBroker().stockPositions();
    return positions.find((p) => p.symbol === symbol) ?? null;
  }

  /** `GET /v1/stock/quote?symbol=`: bid, ask, shares held and sellable. */
  /** What a debit spread would be, and each check. Sends nothing. */
  async spreadCheck(body: Body) {
    return this.engine.checkSpreadOrder(spreadRequest(body));
  }

  /** Checks a debit spread and, when it passes, starts it. Answers at once. */
  async spreadBuy(body: Body) {
    const request = spreadRequest(body);
    const busy = this.store
      .runningJobs(this.userId)
      .some((j) => j.symbol === request.long || j.symbol === request.short);
    if (busy)
      throw new RequestError(
        "One of these contracts already has an order in progress; wait for it",
        409,
      );
    const plan = await this.engine.planSpread(request);
    if ("refused" in plan) {
      this.record("spread", body, `refused: ${plan.refused.join("; ")}`);
      return { status: "refused" as const, ...plan };
    }
    const jobId = this.start("spread", plan.long, request, (id) =>
      this.engine.runSpread(plan, (p) => this.progress.set(id, p)),
    );
    this.record(
      "spread",
      body,
      `started ${jobId}: ${plan.qty} ${plan.long} / ${plan.short} @ ${plan.limitPrice.toFixed(2)}`,
    );
    return {
      status: "started" as const,
      jobId,
      paper: plan.paper,
      long: plan.long,
      short: plan.short,
      qty: plan.qty,
      limitPrice: plan.limitPrice,
      maxLoss: plan.maxLoss,
      offHours: plan.offHours,
      notes: plan.notes,
    };
  }

  /** Closes a held spread with one order for a net credit. Answers at once. */
  async spreadClose(body: Body) {
    const request = spreadRequest(body, true);
    const busy = this.store
      .runningJobs(this.userId)
      .some((j) => j.symbol === request.long || j.symbol === request.short);
    if (busy)
      throw new RequestError(
        "One of these contracts already has an order in progress; wait for it",
        409,
      );
    let plan;
    try {
      plan = await this.engine.planClose(request);
    } catch (error) {
      this.record("spread-close", body, `refused: ${message(error)}`);
      if (error instanceof TradeRefusal)
        throw new RequestError(
          [error.detail, error.hint].filter(Boolean).join(". "),
          422,
        );
      throw error;
    }
    const jobId = this.start("spread-close", plan.long, request, (id) =>
      this.engine.closeSpread(plan, (p) => this.progress.set(id, p)),
    );
    this.record(
      "spread-close",
      body,
      `started ${jobId}: ${plan.qty} ${plan.long} / ${plan.short} for ${plan.credit.toFixed(2)}`,
    );
    return { status: "started" as const, jobId, ...plan };
  }

  async stockQuote(query: Body) {
    const symbol = this.stockSymbol(query);
    const client = this.stockBroker();
    const [quote, held, open, marketOpen] = await Promise.all([
      client.stockQuote(symbol).catch((error) => {
        throw new RequestError(message(error), 502);
      }),
      this.heldShares(symbol),
      this.broker.openOrders(symbol),
      this.broker.marketOpen().catch(() => null),
    ]);
    const qty = held?.qty ?? 0;
    return {
      symbol,
      bid: quote.bid,
      ask: quote.ask,
      last: quote.last,
      quotedAt:
        quote.quotedAt === undefined
          ? null
          : new Date(quote.quotedAt).toISOString(),
      marketOpen,
      held: qty,
      avgEntryPrice: held?.avgEntryPrice ?? null,
      sellable: sellableShares(qty, symbol, open),
      // Where a buy and a sell would start.
      buyPrice: stockStepPrice("buy", quote, 0),
      sellPrice: stockStepPrice("sell", quote, 0),
      // Every open order of the stock, stops and trailing stops included.
      openOrders: open.map((o) => ({
        orderId: o.id,
        side: o.side,
        type: o.type ?? (o.stopPrice === null ? "limit" : "stop"),
        timeInForce: o.timeInForce ?? "day",
        qty: o.qty,
        filledQty: o.filledQty,
        price: o.limitPrice,
        limitPrice: o.limitPrice,
        stopPrice: o.stopPrice,
        trailPercent: o.trailPercent ?? null,
        trailPrice: o.trailPrice ?? null,
        extendedHours: o.extendedHours ?? false,
      })),
    };
  }

  private busy(symbol: string) {
    if (this.store.runningJobs(this.userId).some((j) => j.symbol === symbol))
      throw new RequestError(
        `${symbol} already has an order in progress; wait for it`,
        409,
      );
  }

  /**
   * `POST /v1/stock/buy` `{ symbol, qty }` or `{ symbol, amount }` (dollars,
   * turned into whole shares at the ask). Answers at once; runs as a job.
   */
  async stockBuy(body: Body) {
    const symbol = this.stockSymbol(body);
    const client = this.stockBroker();
    const qtyIn = number(body, "qty");
    const amount = number(body, "amount");
    if ((qtyIn === undefined) === (amount === undefined))
      throw new RequestError("Give a size: qty (shares) or amount (dollars)");
    if (qtyIn !== undefined && !(Number.isInteger(qtyIn) && qtyIn >= 1))
      throw new RequestError("qty must be a whole number of shares");
    if (amount !== undefined && !(amount > 0))
      throw new RequestError("amount must be above zero");
    this.busy(symbol);
    let qty = qtyIn ?? 0;
    if (amount !== undefined) {
      const quote = await client.stockQuote(symbol).catch((error) => {
        throw new RequestError(message(error), 502);
      });
      const price = quote.ask ?? quote.last;
      if (price === null)
        throw new RequestError(`No price for ${symbol} right now`, 422);
      qty = sharesFor(amount, price);
      if (qty < 1)
        throw new RequestError(
          `$${amount} does not buy one share of ${symbol} at ${price}`,
          422,
        );
    }
    const request = { symbol, side: "buy" as const, qty };
    const jobId = this.start("stock-buy", symbol, request, (id) =>
      this.runStock(id, request),
    );
    this.record("stock-buy", body, `started ${jobId}: ${qty} ${symbol}`);
    return {
      status: "started" as const,
      jobId,
      paper: this.broker.capabilities.paper,
      symbol,
      qty,
    };
  }

  /**
   * `POST /v1/stock/sell` `{ symbol, qty: "all" | "half" | n }`. Only shares
   * held and not already offered by an open sell; never short.
   */
  async stockSell(body: Body) {
    const symbol = this.stockSymbol(body);
    this.stockBroker();
    const asked = typeof body.qty === "number" ? String(body.qty) : body.qty;
    if (typeof asked !== "string" || !/^(all|half|\d{1,7})$/.test(asked))
      throw new RequestError("qty must be all, half or a number of shares");
    this.busy(symbol);
    const [held, open] = await Promise.all([
      this.heldShares(symbol),
      this.broker.openOrders(symbol),
    ]);
    if (!held || !(held.qty > 0))
      throw new RequestError(`No long position in ${symbol}`);
    let qty: number;
    try {
      qty = stockSellQty(asked, sellableShares(held.qty, symbol, open));
    } catch (error) {
      throw new RequestError(message(error), 422);
    }
    const request = { symbol, side: "sell" as const, qty };
    const jobId = this.start("stock-sell", symbol, request, (id) =>
      this.runStock(id, request),
    );
    this.record(
      "stock-sell",
      body,
      `started ${jobId}: ${qty} of ${held.qty} ${symbol}`,
    );
    return {
      status: "started" as const,
      jobId,
      paper: this.broker.capabilities.paper,
      symbol,
      selling: qty,
      held: held.qty,
    };
  }

  /**
   * `POST /v1/stock/order`: one stock order of any type, sent as it is (user
   * 2026-10-17). Fields: `symbol`, `side`, `type` (market, limit, stop,
   * stop_limit, trailing_stop), `timeInForce` (day, gtc, opg, cls, ioc, fok),
   * `qty` (shares; `all` or `half` for a sell) or `amount` (dollars, a buy),
   * `limitPrice`, `stopPrice`, `trailPercent` | `trailPrice`,
   * `extendedHours`. `check: true` answers what would be sent and sends
   * nothing. A sell never goes beyond the shares held and not offered.
   */
  async stockOrder(body: Body) {
    const symbol = this.stockSymbol(body);
    const client = this.stockBroker();
    if (!this.broker.stockOrder)
      throw new RequestError("This broker cannot take stock orders", 501);
    const checkOnly = body.check === true;
    if (body.check !== undefined && typeof body.check !== "boolean")
      throw new RequestError("check must be true or false");
    if (!checkOnly) this.busy(symbol);
    const [quote, held, open, marketOpen] = await Promise.all([
      client.stockQuote(symbol).catch((error) => {
        throw new RequestError(message(error), 502);
      }),
      this.heldShares(symbol),
      this.broker.openOrders(symbol),
      this.broker.marketOpen().catch(() => null),
    ]);
    let checked;
    try {
      checked = stockTicket(symbol, body, {
        quote,
        held: Math.max(held?.qty ?? 0, 0),
        open,
        marketOpen,
      });
    } catch (error) {
      if (error instanceof TicketError)
        throw new RequestError(error.message, 422);
      throw error;
    }
    const answer = {
      paper: this.broker.capabilities.paper,
      ...checked.ticket,
      held: held?.qty ?? 0,
      sellable: checked.sellable,
      bid: quote.bid,
      ask: quote.ask,
      last: quote.last,
      estimatedCost: checked.estimatedCost,
      notes: checked.notes,
    };
    if (checkOnly) return { status: "checked" as const, ...answer };
    let order;
    try {
      order = await this.broker.stockOrder(checked.ticket);
    } catch (error) {
      this.record("stock-order", body, `refused: ${message(error)}`);
      throw new RequestError(message(error), 502);
    }
    this.record(
      "stock-order",
      body,
      `sent ${order.id}: ${checked.ticket.side} ${checked.ticket.qty} ${symbol} ${checked.ticket.type} ${checked.ticket.timeInForce}`,
    );
    // Whatever the order did, look at the account (never short).
    const { problems } = await this.engine.shortCheck().catch((error) => ({
      problems: [`the short check failed: ${message(error)}`],
    }));
    return {
      status: "sent" as const,
      ...answer,
      orderId: order.id,
      orderStatus: order.status,
      filledQty: order.filledQty,
      avgPrice: order.filledAvgPrice,
      shortRisks: problems,
    };
  }

  /**
   * `POST /v1/orders/change` `{ orderId, qty?, limitPrice?, stopPrice?,
   * trail?, timeInForce? }`: changes an open stock order. A sell may not grow
   * beyond the shares free for it.
   */
  async changeOrder(body: Body) {
    const order = await this.openOrder(body.orderId);
    if (occ.test(order.symbol))
      throw new RequestError(
        "Option orders are changed with their own controls (price, stop)",
        409,
      );
    if (!this.broker.changeOrder)
      throw new RequestError("This broker cannot change orders", 501);
    if (
      this.store.runningJobs(this.userId).some((j) => j.symbol === order.symbol)
    )
      throw new RequestError(
        "The service is moving this order's price right now; try again in a few seconds",
        409,
      );
    const [held, open] = await Promise.all([
      this.heldShares(order.symbol),
      this.broker.openOrders(order.symbol),
    ]);
    let change;
    try {
      change = stockChange(order, body, {
        held: Math.max(held?.qty ?? 0, 0),
        open,
      });
    } catch (error) {
      if (error instanceof TicketError)
        throw new RequestError(error.message, 422);
      throw error;
    }
    let changed;
    try {
      changed = await this.broker.changeOrder(order.id, change);
    } catch (error) {
      throw new RequestError(message(error), 502);
    }
    this.record(
      "change-order",
      body,
      `${order.symbol} ${order.id} -> ${changed.id}: ${JSON.stringify(change)}`,
    );
    const { problems } = await this.engine.shortCheck().catch((error) => ({
      problems: [`the short check failed: ${message(error)}`],
    }));
    return {
      symbol: order.symbol,
      orderId: changed.id,
      was: order.id,
      change,
      shortRisks: problems,
    };
  }

  private async runStock(
    id: string,
    request: { symbol: string; side: "buy" | "sell"; qty: number },
  ) {
    this.progress.set(id, { stage: "sending" });
    const result = await workStockOrder(this.stockBroker(), request, {
      log: this.log,
      ...(this.sleep ? { sleep: this.sleep } : {}),
      onOrder: (order) =>
        this.progress.set(id, { stage: "moving the price", orderId: order.id }),
    });
    return {
      symbol: request.symbol,
      side: request.side,
      qty: request.qty,
      status: result.status,
      filledQty: result.order.filledQty,
      avgPrice: result.order.filledAvgPrice,
      orderId: result.order.id,
      prices: result.prices,
      ...(result.raiseError ? { raiseError: result.raiseError } : {}),
      // A remainder stays working as a day order, pre/after-hours included.
      working: result.status === "open" || result.status === "partial",
    };
  }

  /** A stock order's new limit price; no size limit (user 2026-10-16). */
  private async repriceStock(
    order: {
      id: string;
      symbol: string;
      side: string;
      qty: number;
      limitPrice: number | null;
    },
    asked: number,
    body: Body,
  ) {
    if (
      this.store.runningJobs(this.userId).some((j) => j.symbol === order.symbol)
    )
      throw new RequestError(
        "The service is moving this order's price right now; try again in a few seconds",
        409,
      );
    const price = Number(asked.toFixed(asked >= 1 ? 2 : 4));
    let changed;
    try {
      changed = await this.broker.replace(order.id, price);
    } catch (error) {
      throw new RequestError(message(error), 502);
    }
    this.record(
      "reprice-order",
      body,
      `${order.symbol} ${order.limitPrice ?? "?"} -> ${price}`,
    );
    return {
      contract: order.symbol,
      orderId: changed.id,
      price,
      was: order.limitPrice,
      qty: order.qty,
    };
  }

  /**
   * Run once on start. A job still marked running was cut off by a restart:
   * its open order is canceled, what it filled gets a stop, and the user is
   * told. Nothing is left working without a stop.
   */
  async reconcile() {
    const cut = this.store
      .runningJobs(this.userId)
      .filter((j) => !this.running.has(j.id));
    for (const job of cut) {
      const notes: string[] = [];
      try {
        if (job.kind === "spread" || job.kind === "spread-close") {
          // The job's multi-leg order is withdrawn, like a buy's own order.
          // A spread has no stop to put back.
          const open = (await this.broker.openOrders()).filter((o) =>
            o.legs?.some((l) => l.symbol === job.symbol),
          );
          for (const order of open) await this.broker.cancel(order.id);
          notes.push(
            open.length > 0
              ? `canceled ${open.length} open spread order(s)`
              : "no spread order working",
          );
          this.store.finishJob(job.id, "interrupted", { notes }, this.now());
          this.record("reconcile", { jobId: job.id }, notes.join("; "));
          await this.notifier
            .alert(`Trading service restarted during a ${job.kind}`, [
              job.symbol,
              ...notes,
              "Check the spread's legs in the portfolio.",
            ])
            .catch(() => {});
          continue;
        }
        if (job.kind === "stock-buy" || job.kind === "stock-sell") {
          // No stop for stocks: the job's own limit order is left working,
          // as a finished job would leave it; the user is told.
          const open = await this.broker.openOrders(job.symbol);
          const side = job.kind === "stock-buy" ? "buy" : "sell";
          const left = open.filter(
            (o) => o.side === side && o.stopPrice === null,
          );
          notes.push(
            left.length > 0
              ? `${left.length} ${side} order(s) still working`
              : "no order working",
          );
          this.store.finishJob(job.id, "interrupted", { notes }, this.now());
          this.record("reconcile", { jobId: job.id }, notes.join("; "));
          await this.notifier
            .alert(`Trading service restarted during a ${job.kind}`, [
              job.symbol,
              ...notes,
            ])
            .catch(() => {});
          continue;
        }
        const open = await this.broker.openOrders(job.symbol);
        // A buy's own order, or a sale's limit order; stops stay in place.
        const stale = open.filter((o) =>
          job.kind === "buy"
            ? o.side === "buy"
            : o.side === "sell" && o.stopPrice === null,
        );
        for (const order of stale) await this.broker.cancel(order.id);
        if (stale.length > 0)
          notes.push(`canceled ${stale.length} open ${job.kind} order(s)`);
        const held = await this.broker.position(job.symbol).catch(() => null);
        // A buy made without a stop, by the ticket's choice, gets none.
        const noStop =
          job.kind === "buy" &&
          (job.request as { autoStop?: boolean }).autoStop === false;
        if (noStop) notes.push("bought without a stop, as chosen");
        else if (held && held.qty > 0) {
          const stopPct = (job.request as { stopPct?: number }).stopPct;
          const stop = await this.engine.setStop({
            contract: job.symbol,
            ...(stopPct === undefined ? {} : { stopPct }),
          });
          notes.push(
            "note" in stop
              ? `${held.qty} held, already covered by a stop`
              : `${held.qty} held, stop placed at ${stop.price.toFixed(2)} on ${stop.qty}`,
          );
        } else notes.push("nothing held");
      } catch (error) {
        notes.push(`CHECK BY HAND: ${message(error)}`);
      }
      this.store.finishJob(job.id, "interrupted", { notes }, this.now());
      this.record("reconcile", { jobId: job.id }, notes.join("; "));
      await this.notifier
        .alert(`Trading service restarted during a ${job.kind}`, [
          job.symbol,
          ...notes,
        ])
        .catch(() => {});
    }
    return cut.length;
  }
}
