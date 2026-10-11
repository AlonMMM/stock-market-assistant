import { randomUUID } from "node:crypto";
import type { Broker } from "../../../packages/trading/src/broker.js";
import type {
  BuyProgress,
  BuyRequest,
  TradeEngine,
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
  now?: () => number;
  log?: (line: string) => void;
}

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
  if (sizePct === undefined) throw new RequestError("Need sizePct");
  const expiry = text(body, "expiry", /^(nearest|friday|\d{4}-\d{2}-\d{2})$/);
  const delta = number(body, "delta");
  const stopPct = number(body, "stopPct");
  return {
    ...(contract ? { contract } : { underlying: underlying!, right: right! }),
    sizePct,
    ...(expiry ? { expiry } : {}),
    ...(delta === undefined ? {} : { delta }),
    ...(stopPct === undefined ? {} : { stopPct }),
  };
}

export class TraderService {
  private readonly userId: string;
  private readonly store: TradeStore;
  private readonly engine: TradeEngine;
  private readonly broker: Broker;
  private readonly notifier: Notifier;
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
    const result = await this.engine.preview({
      underlying: request.underlying,
      right: request.right,
      sizePct: request.sizePct,
      ...(request.delta === undefined ? {} : { delta: request.delta }),
      ...(request.stopPct === undefined ? {} : { stopPct: request.stopPct }),
    });
    this.record("preview", body, "ok");
    return result;
  }

  /** Checks the buy and, when it passes, starts it. Answers at once. */
  async buy(body: Body) {
    const request = buyRequest(body);
    const plan = await this.engine.planBuy(request);
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
