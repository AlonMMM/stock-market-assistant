import {
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
}

// TWS tick types (TickType in the TWS API).
const tick = { bid: 1, ask: 2, last: 4, modelOption: 13 } as const;
// TWS error codes that only report, such as market-data farm messages.
const informational = new Set([2104, 2106, 2107, 2108, 2158, 2119, 10167]);
const noContract = 200;

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

export class StoqeyTws implements TwsClient {
  private readonly ib: IBApi;
  private readonly log: (line: string) => void;
  private readonly timeoutMs: number;
  private ready: Promise<void> | null = null;
  private nextOrderId = 0;
  private nextReqId = 1000;
  // Every order seen this session, kept up to date by the Gateway's events.
  private readonly known = new Map<number, IbOrderState>();
  // Requests without an id (positions, open orders) run one at a time.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TwsOptions) {
    this.log = options.log ?? (() => {});
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.ib = new IBApi({
      host: options.host,
      port: options.port,
      clientId: options.clientId,
    });
    this.ib.on(EventName.disconnected, () => {
      this.log("ibkr: disconnected from the Gateway");
      this.ready = null;
    });
    this.ib.on(EventName.error, (error, code, reqId) => {
      if (!informational.has(code))
        this.log(`ibkr: error ${code} (request ${reqId}): ${error.message}`);
    });
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

  snapshot(contract: IbContract): Promise<IbSnapshot> {
    const snap: IbSnapshot = {
      bid: null,
      ask: null,
      last: null,
      delta: null,
      at: null,
    };
    return this.request<IbSnapshot>(
      (reqId) => this.ib.reqMktData(reqId, toIb(contract), "", true, false),
      (reqId, finish) => {
        const onPrice = (id: number, field: number, value: number) => {
          if (id !== reqId || !(value > 0)) return;
          if (field === tick.bid) snap.bid = value;
          else if (field === tick.ask) snap.ask = value;
          else if (field === tick.last) snap.last = value;
          snap.at = Date.now();
        };
        const onGreeks = (
          id: number,
          field: number,
          _attrib: number | undefined,
          _iv?: number,
          delta?: number,
        ) => {
          if (
            id === reqId &&
            field === tick.modelOption &&
            typeof delta === "number" &&
            Math.abs(delta) <= 1
          )
            snap.delta = delta;
        };
        const onEnd = (id: number) => id === reqId && finish(snap);
        this.ib.on(EventName.tickPrice, onPrice);
        this.ib.on(EventName.tickOptionComputation, onGreeks);
        this.ib.on(EventName.tickSnapshotEnd, onEnd);
        return () => {
          this.ib.off(EventName.tickPrice, onPrice);
          this.ib.off(EventName.tickOptionComputation, onGreeks);
          this.ib.off(EventName.tickSnapshotEnd, onEnd);
        };
      },
    );
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
