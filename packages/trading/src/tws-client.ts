import {
  BarSizeSetting,
  EventName,
  IBApi,
  OptionType,
  SecType,
  type Contract,
  type Order,
  type OrderAction,
  type OrderState,
  type OrderType,
  type TimeInForce,
} from "@stoqey/ib";
import type {
  IbContract,
  IbOrderRequest,
  IbOrderState,
  IbPosition,
  IbSnapshot,
  TwsClient,
} from "./ibkr-trading.js";

// `TwsClient` over @stoqey/ib's event API: one socket to the IB Gateway on
// Railway's private network (docs/ibkr-operations.md). Each request waits for
// its end event or a timeout. Market data is real time only: no delayed or
// frozen quotes are ever asked for (the never-delayed rule of the collector).

export interface TwsOptions {
  host: string;
  port: number;
  clientId: number;
  log?: (line: string) => void;
  timeoutMs?: number;
  // How long a quote waits for its bid, ask (and an option's model delta)
  // before it answers with what came.
  quoteMs?: number;
  // Market-data lines the streams may hold (IBKR's default allowance is 100).
  streamLines?: number;
  // Of those, how many the watched stocks may keep.
  pinnedLines?: number;
  // An option stream nobody read for this long is closed.
  idleMs?: number;
  // Tests: a stand-in for the Gateway connection.
  api?: IBApi;
}

/**
 * One contract's live quote: TWS keeps sending its changes, so a read is the
 * stream's current values, with no request to wait for.
 */
interface QuoteStream {
  reqId: number;
  key: string;
  contract: IbContract;
  option: boolean;
  snap: IbSnapshot;
  // Tick types seen; a side with no market arrives as -1 or 0.
  seen: Set<number>;
  usedAt: number;
  // Whether a read already waited its full quoteMs (an option whose delta
  // never comes): later reads answer at once with what the stream has.
  waited: boolean;
  wake: Set<(error?: Error) => void>;
}

// TWS tick types (TickType in the TWS API).
const tick = { bid: 1, ask: 2, last: 4, modelOption: 13 } as const;
// TWS error codes that only report, such as market-data farm messages.
const informational = new Set([2104, 2106, 2107, 2108, 2158, 2119, 10167]);
const noContract = 200;
// "Historical Market Data Service error message": no data in the window (or
// a pacing violation, told apart by its words).
const noHistory = 162;

/** A time as TWS's UTC form for historical requests: 20261103-14:30:00. */
function twsUtc(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19)}`;
}

const ibSymbol = (s: string) => s.replace(".", " ");
const ourSymbol = (s: string) => s.replace(" ", ".");

function toIb(c: IbContract): Contract {
  return {
    ...(c.conId ? { conId: c.conId } : {}),
    symbol: ibSymbol(c.symbol),
    secType: c.secType === "OPT" ? SecType.OPT : SecType.STK,
    exchange: c.exchange,
    currency: c.currency,
    ...(c.secType === "OPT"
      ? {
          lastTradeDateOrContractMonth: c.lastTradeDateOrContractMonth,
          strike: c.strike,
          right: c.right === "C" ? OptionType.Call : OptionType.Put,
          multiplier: Number(c.multiplier ?? 100),
        }
      : {}),
  };
}

function fromIb(c: Contract): IbContract | null {
  if (c.secType !== SecType.OPT && c.secType !== SecType.STK) return null;
  const base = {
    ...(c.conId ? { conId: c.conId } : {}),
    symbol: ourSymbol(c.symbol ?? ""),
    exchange: c.exchange || "SMART",
    currency: c.currency ?? "USD",
  };
  if (c.secType === SecType.STK) return { ...base, secType: "STK" };
  return {
    ...base,
    secType: "OPT",
    lastTradeDateOrContractMonth: (c.lastTradeDateOrContractMonth ?? "").slice(
      0,
      8,
    ),
    strike: c.strike ?? 0,
    right: c.right === OptionType.Call ? "C" : "P",
    multiplier: String(c.multiplier ?? 100),
  };
}

/** A contract's stream key: its conId, else its description. */
const streamKey = (c: IbContract) =>
  c.conId ? `#${c.conId}` : JSON.stringify(toIb(c));

export class StoqeyTws implements TwsClient {
  private readonly ib: IBApi;
  private readonly log: (line: string) => void;
  private readonly timeoutMs: number;
  private readonly quoteMs: number;
  private ready: Promise<void> | null = null;
  private nextOrderId = 0;
  private nextReqId = 1000;
  // Every order seen this session, kept up to date by the Gateway's events.
  private readonly known = new Map<number, IbOrderState>();
  // Requests without an id (positions, open orders) run one at a time.
  private queue: Promise<unknown> = Promise.resolve();
  private readonly streamLines: number;
  private readonly pinnedLines: number;
  private readonly idleMs: number;
  // Live quote streams by contract, and by their request id.
  private readonly streams = new Map<string, QuoteStream>();
  private readonly byReq = new Map<number, QuoteStream>();
  // Contracts kept streaming whatever their use (the watched stocks).
  private pins = new Map<string, IbContract>();

  constructor(private readonly options: TwsOptions) {
    this.log = options.log ?? (() => {});
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.quoteMs = options.quoteMs ?? 3_000;
    this.streamLines = options.streamLines ?? 90;
    this.pinnedLines = options.pinnedLines ?? 50;
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.ib =
      options.api ??
      new IBApi({
        host: options.host,
        port: options.port,
        clientId: options.clientId,
      });
    this.ib.on(EventName.disconnected, () => {
      this.log("ibkr: disconnected from the Gateway");
      this.ready = null;
      // The Gateway forgets every stream with the connection.
      for (const stream of [...this.streams.values()])
        this.drop(stream, new Error("disconnected from the IB Gateway"));
    });
    this.ib.on(EventName.error, (error, code, reqId) => {
      if (!informational.has(code))
        this.log(`ibkr: error ${code} (request ${reqId}): ${error.message}`);
      const stream = this.byReq.get(reqId);
      if (stream && !informational.has(code))
        this.drop(stream, Object.assign(new Error(error.message), { code }));
    });
    this.ib.on(EventName.tickPrice, (reqId, field, value) => {
      const stream = this.byReq.get(reqId);
      if (!stream) return;
      stream.seen.add(field);
      // A side with no market (-1 or 0) has no price now, not its old one.
      const price = value > 0 ? value : null;
      if (field === tick.bid) stream.snap.bid = price;
      else if (field === tick.ask) stream.snap.ask = price;
      else if (field === tick.last && price !== null) stream.snap.last = price;
      if (price !== null) stream.snap.at = Date.now();
      for (const wake of stream.wake) wake();
    });
    this.ib.on(
      EventName.tickOptionComputation,
      (reqId, field, _attrib, iv, delta) => {
        const stream = this.byReq.get(reqId);
        if (!stream || field !== tick.modelOption) return;
        if (typeof delta === "number" && Math.abs(delta) <= 1)
          stream.snap.delta = delta;
        // TWS sends a huge sentinel when it has no value.
        if (typeof iv === "number" && iv > 0 && iv < 100) stream.snap.iv = iv;
        for (const wake of stream.wake) wake();
      },
    );
    this.ib.on(EventName.openOrder, (orderId, contract, order, state) =>
      this.remember(orderId, contract, order, state),
    );
    this.ib.on(
      EventName.orderStatus,
      (orderId, status, filled, _remaining, avgFillPrice) => {
        const o = this.known.get(orderId);
        if (o)
          this.known.set(orderId, {
            ...o,
            status: String(status),
            filled,
            avgFillPrice,
          });
      },
    );
  }

  private remember(
    orderId: number,
    contract: Contract,
    order: Order,
    state: OrderState,
  ) {
    const c = fromIb(contract);
    if (!c) return;
    const before = this.known.get(orderId);
    this.known.set(orderId, {
      orderId,
      contract: c,
      action: order.action === "SELL" ? "SELL" : "BUY",
      totalQuantity: order.totalQuantity ?? 0,
      orderType: String(order.orderType),
      lmtPrice: order.lmtPrice ?? null,
      auxPrice: order.auxPrice ?? null,
      tif: order.tif === "GTC" ? "GTC" : "DAY",
      ...(order.outsideRth ? { outsideRth: true } : {}),
      status: String(state.status ?? before?.status ?? "Submitted"),
      filled: before?.filled ?? order.filledQuantity ?? 0,
      avgFillPrice: before?.avgFillPrice ?? 0,
    });
  }

  /** Connects once; again after a drop. Resolves with the next order id. */
  private connect(): Promise<void> {
    return (this.ready ??= new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ready = null;
        reject(
          new Error(
            `IB Gateway at ${this.options.host}:${this.options.port} did not answer`,
          ),
        );
      }, this.timeoutMs);
      this.ib.once(EventName.nextValidId, (id) => {
        clearTimeout(timer);
        this.nextOrderId = Math.max(this.nextOrderId, id);
        // Real-time quotes only; never delayed or frozen ones.
        this.ib.reqMarketDataType(1);
        this.log("ibkr: connected to the Gateway");
        resolve();
        // The watched stocks stream again after a drop.
        for (const contract of this.pins.values()) this.open(contract);
      });
      this.ib.connect(this.options.clientId);
    }));
  }

  /** One request by id: collects events until `end`, an error or a timeout. */
  private request<T>(
    start: (reqId: number) => void,
    collect: (
      reqId: number,
      finish: (value: T) => void,
      fail: (error: Error) => void,
    ) => () => void,
    stop?: (reqId: number) => void,
  ): Promise<T> {
    return this.connect().then(
      () =>
        new Promise<T>((resolve, reject) => {
          const reqId = this.nextReqId++;
          let unsubscribe = () => {};
          const end = () => {
            clearTimeout(timer);
            unsubscribe();
            this.ib.off(EventName.error, onError);
            stop?.(reqId);
          };
          const finish = (value: T) => {
            end();
            resolve(value);
          };
          const fail = (error: Error) => {
            end();
            reject(error);
          };
          const onError = (error: Error, code: number, id: number) => {
            if (id === reqId && !informational.has(code))
              fail(Object.assign(new Error(error.message), { code }));
          };
          const timer = setTimeout(
            () => fail(new Error(`IB Gateway request ${reqId} timed out`)),
            this.timeoutMs,
          );
          this.ib.on(EventName.error, onError);
          unsubscribe = collect(reqId, finish, fail);
          start(reqId);
        }),
    );
  }

  /** Requests without an id run one after the other. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  contracts(contract: IbContract): Promise<IbContract[]> {
    const found: IbContract[] = [];
    return this.request<IbContract[]>(
      (reqId) => this.ib.reqContractDetails(reqId, toIb(contract)),
      (reqId, finish) => {
        const onDetails = (id: number, details: { contract: Contract }) => {
          if (id !== reqId) return;
          const c = fromIb(details.contract);
          if (c) found.push(c);
        };
        const onEnd = (id: number) => id === reqId && finish(found);
        this.ib.on(EventName.contractDetails, onDetails);
        this.ib.on(EventName.contractDetailsEnd, onEnd);
        return () => {
          this.ib.off(EventName.contractDetails, onDetails);
          this.ib.off(EventName.contractDetailsEnd, onEnd);
        };
      },
    ).catch((error: { code?: number }) => {
      // "No security definition has been found": no such contract.
      if (error.code === noContract) return [];
      throw error;
    });
  }

  optionParams(symbol: string, conId: number) {
    const all: {
      exchange: string;
      expirations: string[];
      strikes: number[];
    }[] = [];
    return this.request<{ expirations: string[]; strikes: number[] }>(
      (reqId) =>
        this.ib.reqSecDefOptParams(reqId, ibSymbol(symbol), "", "STK", conId),
      (reqId, finish) => {
        const onParam = (
          id: number,
          exchange: string,
          _underlying: number,
          _tradingClass: string,
          _multiplier: string,
          expirations: string[],
          strikes: number[],
        ) => {
          if (id === reqId) all.push({ exchange, expirations, strikes });
        };
        const onEnd = (id: number) => {
          if (id !== reqId) return;
          // SMART lists what can be routed; otherwise every exchange's union.
          const pick = all.filter((p) => p.exchange === "SMART");
          const use = pick.length > 0 ? pick : all;
          finish({
            expirations: [...new Set(use.flatMap((p) => p.expirations))],
            strikes: [...new Set(use.flatMap((p) => p.strikes))],
          });
        };
        this.ib.on(EventName.securityDefinitionOptionParameter, onParam);
        this.ib.on(EventName.securityDefinitionOptionParameterEnd, onEnd);
        return () => {
          this.ib.off(EventName.securityDefinitionOptionParameter, onParam);
          this.ib.off(EventName.securityDefinitionOptionParameterEnd, onEnd);
        };
      },
    );
  }

  /**
   * The contract's bid, ask and last (an option's model delta and IV too)
   * from its live stream. The first read opens the stream and answers as
   * soon as the bid and ask (and an option's delta) have come, at most
   * `quoteMs` later with what came; the stream then stays open, so every
   * later read answers at once with IBKR's current values (the owner,
   * 2026-11-04: "the fastest we can be"). A one-off TWS snapshot waited up
   * to about 11 s, and a stream per read up to 3 s each time.
   */
  async snapshot(contract: IbContract): Promise<IbSnapshot> {
    await this.connect();
    const stream = this.open(contract);
    stream.usedAt = Date.now();
    if (!this.complete(stream) && !stream.waited) {
      await new Promise<void>((resolve, reject) => {
        const done = (error?: Error) => {
          if (!error && !this.complete(stream)) return;
          clearTimeout(enough);
          stream.wake.delete(done);
          if (error) reject(error);
          else resolve();
        };
        const enough = setTimeout(() => {
          stream.waited = true;
          stream.wake.delete(done);
          resolve();
        }, this.quoteMs);
        stream.wake.add(done);
      });
    }
    // A live stream's values hold now: TWS sends only changes.
    return {
      ...stream.snap,
      at: stream.snap.at === null ? null : Date.now(),
    };
  }

  /**
   * Keeps these contracts streaming (the watched stocks), up to
   * `pinnedLines`; the ones no longer watched become like any other stream.
   */
  async watch(contracts: IbContract[]): Promise<void> {
    const keep = contracts.slice(0, this.pinnedLines);
    if (contracts.length > keep.length)
      this.log(
        `ibkr: streaming ${keep.length} of ${contracts.length} watched stocks (the line allowance)`,
      );
    this.pins = new Map(keep.map((c) => [streamKey(c), c]));
    await this.connect();
    for (const contract of keep) this.open(contract);
  }

  private complete(stream: QuoteStream): boolean {
    return (
      stream.seen.has(tick.bid) &&
      stream.seen.has(tick.ask) &&
      (!stream.option || stream.snap.delta !== null)
    );
  }

  /** The contract's stream, opened when there is none. */
  private open(contract: IbContract): QuoteStream {
    const key = streamKey(contract);
    const known = this.streams.get(key);
    if (known) return known;
    this.makeRoom();
    const stream: QuoteStream = {
      reqId: this.nextReqId++,
      key,
      contract,
      option: contract.secType === "OPT",
      snap: { bid: null, ask: null, last: null, delta: null, at: null },
      seen: new Set(),
      usedAt: Date.now(),
      waited: false,
      wake: new Set(),
    };
    this.streams.set(key, stream);
    this.byReq.set(stream.reqId, stream);
    this.ib.reqMktData(stream.reqId, toIb(contract), "", false, false);
    return stream;
  }

  /**
   * Closes streams nobody read for `idleMs`, then, while the lines are all
   * taken, the least recently read one that is not watched or being waited on.
   */
  private makeRoom() {
    const now = Date.now();
    const free = (s: QuoteStream) => !this.pins.has(s.key) && s.wake.size === 0;
    for (const s of [...this.streams.values()])
      if (free(s) && now - s.usedAt > this.idleMs) this.close(s);
    while (this.streams.size >= this.streamLines) {
      let oldest: QuoteStream | null = null;
      for (const s of this.streams.values())
        if (free(s) && (!oldest || s.usedAt < oldest.usedAt)) oldest = s;
      if (!oldest) return;
      this.close(oldest);
    }
  }

  private close(stream: QuoteStream) {
    this.forget(stream);
    this.ib.cancelMktData(stream.reqId);
  }

  /** A stream TWS ended (an error, a drop): readers waiting get the error. */
  private drop(stream: QuoteStream, error: Error) {
    this.forget(stream);
    for (const wake of [...stream.wake]) wake(error);
  }

  private forget(stream: QuoteStream) {
    if (this.streams.get(stream.key) === stream)
      this.streams.delete(stream.key);
    this.byReq.delete(stream.reqId);
  }

  /** Contracts traded in each 1-minute bar (TRADES) of the `minutes` up to `end` (ms). */
  minuteVolumes(
    contract: IbContract,
    end: number,
    minutes: number,
  ): Promise<number[]> {
    const volumes: number[] = [];
    type WhatToShow = Parameters<IBApi["reqHistoricalData"]>[5];
    return this.request<number[]>(
      (reqId) =>
        this.ib.reqHistoricalData(
          reqId,
          toIb(contract),
          twsUtc(end),
          `${minutes * 60} S`,
          BarSizeSetting.MINUTES_ONE,
          "TRADES" as WhatToShow,
          1,
          2,
          false,
        ),
      (reqId, finish) => {
        const onBar = (
          id: number,
          time: string,
          _open: number,
          _high: number,
          _low: number,
          _close: number,
          volume: number,
        ) => {
          if (id !== reqId) return;
          // The last row is the end marker ("finished-...").
          if (time.startsWith("finished")) return finish(volumes);
          volumes.push(volume > 0 ? volume : 0);
        };
        this.ib.on(EventName.historicalData, onBar);
        return () => this.ib.off(EventName.historicalData, onBar);
      },
    ).catch((error: { code?: number; message?: string }) => {
      // No trade in the window: nothing traded. The same code also reports a
      // pacing violation, which stays an error.
      if (error.code === noHistory && /no data/i.test(error.message ?? ""))
        return [];
      throw error;
    });
  }

  async placeOrder(
    contract: IbContract,
    order: IbOrderRequest,
    id?: number,
  ): Promise<number> {
    await this.connect();
    const orderId = id ?? this.nextOrderId++;
    const ibOrder: Order = {
      action: order.action as OrderAction,
      totalQuantity: order.totalQuantity,
      orderType: order.orderType as OrderType,
      ...(order.lmtPrice !== undefined ? { lmtPrice: order.lmtPrice } : {}),
      ...(order.auxPrice !== undefined ? { auxPrice: order.auxPrice } : {}),
      tif: order.tif as TimeInForce,
      outsideRth: order.outsideRth ?? false,
      transmit: true,
    };
    const before = this.known.get(orderId);
    // Known at once, so the trade flow can follow it before TWS answers.
    this.known.set(orderId, {
      orderId,
      contract,
      action: order.action,
      totalQuantity: order.totalQuantity,
      orderType: order.orderType,
      lmtPrice: order.lmtPrice ?? null,
      auxPrice: order.auxPrice ?? null,
      tif: order.tif,
      ...(order.outsideRth ? { outsideRth: true } : {}),
      status: before?.status ?? "PendingSubmit",
      filled: before?.filled ?? 0,
      avgFillPrice: before?.avgFillPrice ?? 0,
    });
    this.ib.placeOrder(orderId, toIb(contract), ibOrder);
    return orderId;
  }

  async cancelOrder(id: number) {
    await this.connect();
    this.ib.cancelOrder(id);
  }

  /** Open orders of every client, and what this session saw finish. */
  orders(): Promise<IbOrderState[]> {
    return this.serial(() =>
      this.request<IbOrderState[]>(
        () => this.ib.reqAllOpenOrders(),
        (_reqId, finish) => {
          const onEnd = () => finish([...this.known.values()]);
          this.ib.on(EventName.openOrderEnd, onEnd);
          return () => this.ib.off(EventName.openOrderEnd, onEnd);
        },
      ),
    );
  }

  positions(): Promise<IbPosition[]> {
    const held: IbPosition[] = [];
    return this.serial(() =>
      this.request<IbPosition[]>(
        () => this.ib.reqPositions(),
        (_reqId, finish) => {
          const onPosition = (
            _account: string,
            contract: Contract,
            pos: number,
            avgCost?: number,
          ) => {
            const c = fromIb(contract);
            if (c && pos !== 0)
              held.push({ contract: c, position: pos, avgCost: avgCost ?? 0 });
          };
          const onEnd = () => finish(held);
          this.ib.on(EventName.position, onPosition);
          this.ib.on(EventName.positionEnd, onEnd);
          return () => {
            this.ib.off(EventName.position, onPosition);
            this.ib.off(EventName.positionEnd, onEnd);
          };
        },
        () => this.ib.cancelPositions(),
      ),
    );
  }

  accountValues(): Promise<Record<string, number>> {
    const values: Record<string, number> = {};
    return this.request<Record<string, number>>(
      (reqId) =>
        this.ib.reqAccountSummary(
          reqId,
          "All",
          "NetLiquidation,PreviousDayEquityWithLoanValue,AvailableFunds,BuyingPower",
        ),
      (reqId, finish) => {
        const onValue = (
          id: number,
          _account: string,
          tag: string,
          value: string,
        ) => {
          const n = Number(value);
          if (id === reqId && Number.isFinite(n)) values[tag] = n;
        };
        const onEnd = (id: number) => id === reqId && finish(values);
        this.ib.on(EventName.accountSummary, onValue);
        this.ib.on(EventName.accountSummaryEnd, onEnd);
        return () => {
          this.ib.off(EventName.accountSummary, onValue);
          this.ib.off(EventName.accountSummaryEnd, onEnd);
        };
      },
      (reqId) => this.ib.cancelAccountSummary(reqId),
    );
  }
}
