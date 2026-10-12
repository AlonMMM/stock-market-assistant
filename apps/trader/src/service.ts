import { randomUUID } from "node:crypto";
import type { Broker } from "../../../packages/trading/src/broker.js";
import {
  TradeRefusal,
  type BuyProgress,
  type BuyRequest,
  type PostStore,
  type TradeEngine,
} from "../../../packages/trading/src/engine.js";
import { exitQty } from "../../../packages/trading/src/exit.js";
import { parseOccSymbol } from "../../../packages/trading/src/options.js";
import type { Notifier } from "../../../packages/trading/src/notifier.js";
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
  return {
    ...(contract ? { contract } : { underlying: underlying!, right: right! }),
    ...(qty === undefined ? { sizePct: sizePct! } : { qty }),
    ...(expiry ? { expiry } : {}),
    ...(delta === undefined ? {} : { delta }),
    ...(strike === undefined ? {} : { strike }),
    ...(stopPct === undefined ? {} : { stopPct }),
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

  /** Checks the buy and, when it passes, starts it. Answers at once. */
  async buy(body: Body) {
    const request = buyRequest(body);
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
    if (this.store.runningJobs().some((j) => j.symbol === symbol))
      throw new RequestError(
        `${symbol} already has an order in progress; wait for it`,
        409,
      );
    const stopPct = number(body, "stopPct");
    const request = {
      contract: symbol,
      qty,
      ...(stopPct === undefined ? {} : { stopPct }),
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
    if (this.store.runningJobs().some((j) => j.symbol === symbol))
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
      const stops = open.filter(
        (o) => o.side === "sell" && o.stopPrice !== null,
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
      .runningJobs()
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
        .runningJobs()
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
        type: o.stopPrice === null ? "limit" : "stop",
        qty: o.qty,
        filledQty: o.filledQty,
        price: o.stopPrice ?? o.limitPrice,
        status: o.status,
      })),
    };
  }

  /**
   * Run once on start. A job still marked running was cut off by a restart:
   * its open order is canceled, what it filled gets a stop, and the user is
   * told. Nothing is left working without a stop.
   */
  async reconcile() {
    const cut = this.store.runningJobs().filter((j) => !this.running.has(j.id));
    for (const job of cut) {
      const notes: string[] = [];
      try {
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
        if (held && held.qty > 0) {
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
