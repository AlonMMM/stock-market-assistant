import assert from "node:assert/strict";
import test from "node:test";
import {
  IbkrTrading,
  occSymbol,
  optionContract,
  orderStatus,
  type IbContract,
  type IbOrderRequest,
  type IbOrderState,
  type IbPosition,
  type IbSnapshot,
  type TwsClient,
} from "../packages/trading/src/ibkr-trading.js";

// A fake Gateway with synthetic contracts, quotes and fills.
const nvdaCall = "NVDA261016C00240000";
const key = (c: IbContract) =>
  c.secType === "OPT" ? occSymbol(c) : `STK:${c.symbol}`;

class FakeTws implements TwsClient {
  listed = new Map<string, number>([["STK:NVDA", 1]]);
  quotes = new Map<string, IbSnapshot>();
  params = { expirations: [] as string[], strikes: [] as number[] };
  held: IbPosition[] = [];
  book: IbOrderState[] = [];
  lookups = 0;
  sent: { contract: IbContract; order: IbOrderRequest; id?: number }[] = [];
  values: Record<string, number> = {};
  private nextId = 100;

  list(symbol: string, quote: Partial<IbSnapshot>) {
    this.listed.set(symbol, this.listed.size + 1);
    this.quotes.set(symbol, {
      bid: null,
      ask: null,
      last: null,
      delta: null,
      at: null,
      ...quote,
    });
  }
  paramReads = 0;
  // Contracts traded per minute, by OCC symbol (minuteVolumes).
  volumes = new Map<string, number[]>();
  history: { symbol: string; end: number; minutes: number }[] = [];
  async contracts(c: IbContract) {
    this.lookups++;
    // An option without a strike: every listed strike of that expiry and right.
    if (c.secType === "OPT" && c.strike === undefined)
      return [...this.listed]
        .filter(([k]) => {
          if (k.startsWith("STK:")) return false;
          const o = optionContract(k);
          return (
            o.symbol === c.symbol &&
            o.lastTradeDateOrContractMonth === c.lastTradeDateOrContractMonth &&
            o.right === c.right
          );
        })
        .map(([k, conId]) => ({ ...optionContract(k), conId }));
    const conId = this.listed.get(key(c));
    return conId === undefined ? [] : [{ ...c, conId }];
  }
  async optionParams() {
    this.paramReads++;
    return this.params;
  }
  async minuteVolumes(c: IbContract, end: number, minutes: number) {
    this.history.push({ symbol: key(c), end, minutes });
    return this.volumes.get(key(c)) ?? [];
  }
  async snapshot(c: IbContract) {
    const q = this.quotes.get(key(c));
    if (!q) throw new Error(`no quote ${key(c)}`);
    return q;
  }
  async placeOrder(contract: IbContract, order: IbOrderRequest, id?: number) {
    this.sent.push({ contract, order, ...(id === undefined ? {} : { id }) });
    const state: IbOrderState = {
      orderId: id ?? this.nextId++,
      contract,
      action: order.action,
      totalQuantity: order.totalQuantity,
      orderType: order.orderType,
      lmtPrice: order.lmtPrice ?? null,
      auxPrice: order.auxPrice ?? null,
      tif: order.tif,
      ...(order.outsideRth ? { outsideRth: true } : {}),
      status: "Submitted",
      filled: 0,
      avgFillPrice: 0,
    };
    this.book = [
      ...this.book.filter((o) => o.orderId !== state.orderId),
      state,
    ];
    return state.orderId;
  }
  async cancelOrder(id: number) {
    for (const o of this.book) if (o.orderId === id) o.status = "Cancelled";
  }
  async orders() {
    return this.book;
  }
  async positions() {
    return this.held;
  }
  async accountValues() {
    return this.values;
  }
}

const monday = Date.parse("2026-10-12T15:00:00Z"); // 11:00 in New York
function setup(now = monday) {
  const tws = new FakeTws();
  tws.list(nvdaCall, { bid: 1.0, ask: 1.04, delta: 0.12, at: now });
  const broker = new IbkrTrading(tws, { paper: true, now: () => now });
  return { tws, broker };
}
const holdCalls = (tws: FakeTws, qty: number, avgCost = 103) =>
  tws.held.push({ contract: optionContract(nvdaCall), position: qty, avgCost });

test("ibkr: OCC symbols and IBKR contracts translate both ways", () => {
  const c = optionContract(nvdaCall);
  assert.deepEqual(
    [c.symbol, c.lastTradeDateOrContractMonth, c.right, c.strike],
    ["NVDA", "20261016", "C", 240],
  );
  assert.equal(occSymbol(c), nvdaCall);
  assert.equal(
    occSymbol({ ...c, strike: 7.5, right: "P", symbol: "F" }),
    "F261016P00007500",
  );
});

test("ibkr: TWS statuses become the trade flow's words", () => {
  assert.equal(orderStatus("Filled", 3), "filled");
  assert.equal(orderStatus("Cancelled", 0), "canceled");
  assert.equal(orderStatus("ApiCancelled", 1), "canceled");
  assert.equal(orderStatus("Inactive", 0), "rejected");
  assert.equal(orderStatus("Submitted", 0), "new");
  assert.equal(orderStatus("PreSubmitted", 2), "partially_filled");
});

test("ibkr: a buy is a day limit in cents; the contract is looked up once", async () => {
  const { tws, broker } = setup();
  const first = await broker.buyLimit(nvdaCall, 2, 1.037);
  await broker.buyLimit(nvdaCall, 1, 1.02);
  assert.equal(tws.lookups, 1);
  assert.deepEqual(tws.sent[0]!.order, {
    action: "BUY",
    totalQuantity: 2,
    orderType: "LMT",
    lmtPrice: 1.04,
    tif: "DAY",
  });
  assert.equal(tws.sent[0]!.contract.conId, tws.listed.get(nvdaCall));
  assert.deepEqual(
    [first.symbol, first.status, first.qty, first.limitPrice],
    [nvdaCall, "new", 2, 1.04],
  );
});

test("ibkr: a sell may never sell more than is held and not yet offered", async () => {
  const { tws, broker } = setup();
  await assert.rejects(broker.sellLimit(nvdaCall, 1, 1.0), /short/);
  holdCalls(tws, 3);
  const stop = await broker.sellStop(nvdaCall, 2, 0.62);
  assert.deepEqual(tws.sent.at(-1)!.order, {
    action: "SELL",
    totalQuantity: 2,
    orderType: "STP",
    auxPrice: 0.62,
    tif: "GTC",
  });
  // 3 held, 2 offered by the stop: 1 left.
  await assert.rejects(broker.sellLimit(nvdaCall, 2, 1.0), /2 already offered/);
  await broker.sellLimit(nvdaCall, 1, 1.0);
  // The stop itself may grow to what is held, but not past it.
  await broker.cancel(tws.book.at(-1)!.orderId.toString());
  await broker.replaceStop(stop.id, 3, 0.6);
  assert.equal(tws.sent.at(-1)!.id, Number(stop.id));
  await assert.rejects(broker.replaceStop(stop.id, 4, 0.6), /short/);
});

test("ibkr: a price change keeps the order and its id", async () => {
  const { tws, broker } = setup();
  const o = await broker.buyLimit(nvdaCall, 2, 1.0);
  const changed = await broker.replace(o.id, 1.02);
  assert.equal(changed.id, o.id);
  assert.equal(changed.limitPrice, 1.02);
  assert.equal(tws.sent.at(-1)!.order.totalQuantity, 2);
});

test("ibkr: positions are per contract; a missing one is an error, like Alpaca", async () => {
  const { tws, broker } = setup();
  await assert.rejects(broker.position(nvdaCall), /No position/);
  holdCalls(tws, 4, 103);
  tws.held.push({
    contract: {
      symbol: "NVDA",
      secType: "STK",
      exchange: "SMART",
      currency: "USD",
    },
    position: 10,
    avgCost: 180.5,
  });
  assert.deepEqual(await broker.position(nvdaCall), {
    qty: 4,
    avgEntryPrice: 1.03,
  });
  assert.deepEqual(await broker.positions(), [
    { symbol: nvdaCall, qty: 4, avgEntryPrice: 1.03 },
  ]);
  assert.deepEqual(await broker.stockPositions(), [
    { symbol: "NVDA", qty: 10, avgEntryPrice: 180.5 },
  ]);
});

test("ibkr: open orders leave out finished ones and show stops", async () => {
  const { tws, broker } = setup();
  holdCalls(tws, 2);
  await broker.sellStop(nvdaCall, 2, 0.6);
  const buy = await broker.buyLimit(nvdaCall, 1, 1.0);
  tws.book.find((o) => String(o.orderId) === buy.id)!.status = "Filled";
  const open = await broker.openOrders(nvdaCall);
  assert.equal(open.length, 1);
  assert.deepEqual([open[0]!.side, open[0]!.stopPrice], ["sell", 0.6]);
  assert.equal((await broker.order(buy.id)).status, "filled");
});

test("ibkr: the chain asks out-of-the-money strikes of expiries in range", async () => {
  const { tws, broker } = setup();
  tws.list("STK:NVDA", { last: 200 });
  tws.params = {
    expirations: ["20261016", "20261023", "20261218"],
    strikes: [150, 190, 200, 220, 240, 300],
  };
  for (const strike of [200, 220, 240])
    tws.list(occSymbol({ ...optionContract(nvdaCall), strike }), {
      bid: 1,
      ask: 1.1,
      delta: 0.2,
      iv: 0.38,
      at: monday,
    });
  const quotes = await broker.chain("NVDA", "call", "2026-10-12", "2026-10-30");
  // 300 is past the reach and 150/190 are on the wrong side; the nearest
  // expiry with listed contracts (the 16th) is the one the picker reads.
  assert.deepEqual(quotes.map((q) => q.symbol).sort(), [
    "NVDA261016C00200000",
    "NVDA261016C00220000",
    "NVDA261016C00240000",
  ]);
  assert.deepEqual(
    [
      quotes[0]!.expiry,
      quotes[0]!.right,
      quotes[0]!.delta,
      quotes[0]!.iv,
      quotes[0]!.openInterest,
    ],
    ["2026-10-16", "call", 0.2, 0.38, null],
  );
});

test("ibkr: the chain asks only the strikes nearest the stock, one expiry, and reads its listing once a day", async () => {
  let now = monday;
  const tws = new FakeTws();
  const broker = new IbkrTrading(tws, {
    paper: true,
    now: () => now,
    chainStrikes: 3,
  });
  tws.list("STK:NVDA", { bid: 199.9, ask: 200.1 });
  tws.params = {
    expirations: ["20261016", "20261023"],
    strikes: [195, 200, 205, 210, 215, 220, 225],
  };
  // Every strike of both expiries is listed and quoted.
  for (const expiry of ["20261016", "20261023"])
    for (const strike of tws.params.strikes)
      tws.list(
        occSymbol({
          ...optionContract(nvdaCall),
          strike,
          lastTradeDateOrContractMonth: expiry,
        }),
        { bid: 1, ask: 1.1, delta: 0.2, at: monday },
      );
  const asked: string[] = [];
  const snapshot = tws.snapshot.bind(tws);
  tws.snapshot = async (c) => {
    asked.push(key(c));
    return snapshot(c);
  };
  const first = await broker.chain("NVDA", "call", "2026-10-13", "2026-10-30");
  // The 3 nearest out-of-the-money strikes (and up to 2% in), the 16th only.
  assert.deepEqual(first.map((q) => q.strike).sort(), [200, 205, 210]);
  assert.ok(first.every((q) => q.expiry === "2026-10-16"));
  assert.equal(asked.filter((k) => !k.startsWith("STK")).length, 3);
  const lookups = tws.lookups;
  await broker.chain("NVDA", "call", "2026-10-13", "2026-10-30");
  // Same day: no new listing or expirations read, no contract looked up.
  assert.equal(tws.paramReads, 1);
  assert.equal(tws.lookups, lookups);
  // The next day reads them again.
  now = monday + 86_400_000;
  await broker.chain("NVDA", "call", "2026-10-14", "2026-10-30");
  assert.equal(tws.paramReads, 2);
  assert.ok(tws.lookups > lookups);
});

test("ibkr: the chain uses the caller's stock price and asks IBKR for none", async () => {
  const tws = new FakeTws();
  const broker = new IbkrTrading(tws, {
    paper: true,
    now: () => monday,
    chainStrikes: 3,
  });
  // No stock quote listed: asking for one would find no price.
  tws.params = { expirations: ["20261016"], strikes: [195, 200, 205, 210] };
  for (const strike of tws.params.strikes)
    tws.list(
      occSymbol({
        ...optionContract(nvdaCall),
        strike,
        lastTradeDateOrContractMonth: "20261016",
      }),
      { bid: 1, ask: 1.1, delta: 0.2, at: monday },
    );
  const asked: string[] = [];
  const snapshot = tws.snapshot.bind(tws);
  tws.snapshot = async (c) => {
    asked.push(key(c));
    return snapshot(c);
  };
  const quotes = await broker.chain(
    "NVDA",
    "call",
    "2026-10-13",
    "2026-10-30",
    200,
  );
  assert.deepEqual(quotes.map((q) => q.strike).sort(), [200, 205, 210]);
  assert.equal(asked.filter((k) => k.startsWith("STK")).length, 0);
});

test("ibkr: the 30-minute volume adds IBKR's own minute bars up to the end", async () => {
  const { tws, broker } = setup();
  tws.volumes.set(nvdaCall, [10, 0, 25, 7]);
  const end = monday + 60_000;
  const got = await broker.optionVolume30([nvdaCall], end);
  assert.equal(got.get(nvdaCall), 42);
  assert.deepEqual(tws.history, [{ symbol: nvdaCall, end, minutes: 30 }]);
  // A client without historical bars cannot count them.
  const bare = new FakeTws();
  bare.list(nvdaCall, {});
  (bare as { minuteVolumes?: unknown }).minuteVolumes = undefined;
  const none = new IbkrTrading(bare, { paper: true, now: () => monday });
  await assert.rejects(none.optionVolume30([nvdaCall], end), /historical/);
});

test("ibkr: the market is open in core hours of trading days only", async () => {
  const at = async (iso: string) => setup(Date.parse(iso)).broker.marketOpen();
  assert.equal(await at("2026-10-12T13:30:00Z"), true); // 9:30
  assert.equal(await at("2026-10-12T13:29:00Z"), false);
  assert.equal(await at("2026-10-12T20:00:00Z"), false); // 16:00
  assert.equal(await at("2026-10-17T15:00:00Z"), false); // Saturday
  assert.equal(await at("2026-11-26T15:00:00Z"), false); // Thanksgiving
});

test("ibkr: stocks trade outside regular hours and sell only what is held", async () => {
  const { tws, broker } = setup();
  tws.list("STK:F", { bid: 0.5012, ask: 0.5034, last: 0.502 });
  assert.deepEqual(await broker.stockQuote("F"), {
    symbol: "F",
    bid: 0.5012,
    ask: 0.5034,
    last: 0.502,
  });
  await broker.stockLimit("F", "buy", 10, 0.50237);
  assert.deepEqual(tws.sent.at(-1)!.order, {
    action: "BUY",
    totalQuantity: 10,
    orderType: "LMT",
    lmtPrice: 0.5024,
    tif: "DAY",
    outsideRth: true,
  });
  await assert.rejects(broker.stockLimit("F", "sell", 1, 0.5), /short/);
});

test("ibkr: account values map to equity, previous close and cash to spend", async () => {
  const { tws, broker } = setup();
  tws.values = {
    NetLiquidation: 101000,
    PreviousDayEquityWithLoanValue: 100000,
    AvailableFunds: 40000,
    BuyingPower: 160000,
  };
  assert.deepEqual(await broker.account(), {
    equity: 101000,
    lastEquity: 100000,
    buyingPower: 40000,
  });
  assert.equal(broker.capabilities.closeOnlyOrders, false);
  assert.deepEqual(await broker.equityHistory(), []);
});
