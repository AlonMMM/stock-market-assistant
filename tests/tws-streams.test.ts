import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { EventName, type IBApi } from "@stoqey/ib";
import type { IbContract } from "../packages/trading/src/ibkr-trading.js";
import { StoqeyTws } from "../packages/trading/src/tws-client.js";

// A stand-in for the IB Gateway connection (synthetic quotes): it records the
// streams asked for and cancelled, and the test sends the ticks.
class FakeGateway extends EventEmitter {
  opened: { reqId: number; symbol: string }[] = [];
  cancelled: number[] = [];
  connects = 0;
  connect() {
    this.connects++;
    setImmediate(() => this.emit(EventName.nextValidId, 1));
  }
  reqMarketDataType() {}
  reqMktData(reqId: number, contract: { symbol?: string; strike?: number }) {
    this.opened.push({
      reqId,
      symbol: `${contract.symbol}${contract.strike ?? ""}`,
    });
  }
  cancelMktData(reqId: number) {
    this.cancelled.push(reqId);
  }
  reqOf(symbol: string) {
    return this.opened.filter((o) => o.symbol === symbol).at(-1)!.reqId;
  }
  quote(symbol: string, bid: number, ask: number) {
    const reqId = this.reqOf(symbol);
    this.emit(EventName.tickPrice, reqId, 1, bid);
    this.emit(EventName.tickPrice, reqId, 2, ask);
  }
}

const stock = (symbol: string, conId: number): IbContract => ({
  symbol,
  secType: "STK",
  exchange: "SMART",
  currency: "USD",
  conId,
});
const option: IbContract = {
  symbol: "NVDA",
  secType: "OPT",
  lastTradeDateOrContractMonth: "20261106",
  strike: 200,
  right: "C",
  multiplier: "100",
  exchange: "SMART",
  currency: "USD",
  conId: 900,
};
const tick = () => new Promise((r) => setImmediate(r));

function client(options: { streamLines?: number; quoteMs?: number } = {}) {
  const gateway = new FakeGateway();
  const tws = new StoqeyTws({
    host: "gateway",
    port: 4001,
    clientId: 1,
    quoteMs: options.quoteMs ?? 200,
    ...(options.streamLines ? { streamLines: options.streamLines } : {}),
    api: gateway as unknown as IBApi,
  });
  return { gateway, tws };
}

test("tws streams: the first read waits for the quote; later reads answer at once from the open stream", async () => {
  const { gateway, tws } = client();
  const first = tws.snapshot(stock("NVDA", 1));
  await tick();
  await tick();
  gateway.quote("NVDA", 199.9, 200.1);
  assert.deepEqual([(await first).bid, (await first).ask], [199.9, 200.1]);
  // The price moves: the stream keeps it, no new request.
  gateway.quote("NVDA", 201, 201.2);
  const before = Date.now();
  const second = await tws.snapshot(stock("NVDA", 1));
  assert.deepEqual([second.bid, second.ask], [201, 201.2]);
  assert.ok(second.at! >= before, "a live stream's quote is dated now");
  assert.equal(gateway.opened.length, 1);
  assert.equal(gateway.cancelled.length, 0);
});

test("tws streams: an option whose delta never comes answers after quoteMs once, then at once", async () => {
  const { gateway, tws } = client({ quoteMs: 50 });
  const first = tws.snapshot(option);
  await tick();
  await tick();
  gateway.quote("NVDA200", 1, 1.1);
  const q = await first;
  assert.equal(q.delta, null);
  assert.equal(q.bid, 1);
  const startedAt = Date.now();
  await tws.snapshot(option);
  assert.ok(Date.now() - startedAt < 40, "no second wait");
  // The delta comes later and is read from the stream.
  gateway.emit(
    EventName.tickOptionComputation,
    gateway.reqOf("NVDA200"),
    13,
    0,
    0.4,
    0.2,
  );
  assert.equal((await tws.snapshot(option)).delta, 0.2);
});

test("tws streams: a side with no market clears its old price", async () => {
  const { gateway, tws } = client();
  const first = tws.snapshot(stock("NVDA", 1));
  await tick();
  await tick();
  gateway.quote("NVDA", 199.9, 200.1);
  await first;
  gateway.emit(EventName.tickPrice, gateway.reqOf("NVDA"), 1, -1);
  assert.equal((await tws.snapshot(stock("NVDA", 1))).bid, null);
});

test("tws streams: the watched stocks stay; past the line allowance the least recently read stream closes", async () => {
  const { gateway, tws } = client({ streamLines: 3 });
  await tws.watch([stock("AAPL", 1), stock("MSFT", 2)]);
  assert.deepEqual(
    gateway.opened.map((o) => o.symbol),
    ["AAPL", "MSFT"],
  );
  gateway.quote("AAPL", 1, 1.1);
  gateway.quote("MSFT", 1, 1.1);
  const nvda = tws.snapshot(stock("NVDA", 3));
  await tick();
  gateway.quote("NVDA", 1, 1.1);
  await nvda;
  // A fourth contract: NVDA is the one stream not watched, so it closes.
  const amd = tws.snapshot(stock("AMD", 4));
  await tick();
  gateway.quote("AMD", 1, 1.1);
  await amd;
  assert.deepEqual(gateway.cancelled, [gateway.reqOf("NVDA")]);
  // The watched ones still answer from their streams.
  await tws.snapshot(stock("AAPL", 1));
  assert.equal(gateway.opened.filter((o) => o.symbol === "AAPL").length, 1);
});

test("tws streams: an error ends the stream and fails the read; the next read opens it again", async () => {
  const { gateway, tws } = client();
  const first = tws.snapshot(stock("NVDA", 1));
  await tick();
  await tick();
  gateway.emit(
    EventName.error,
    new Error("No market data during competing live session"),
    10197,
    gateway.reqOf("NVDA"),
  );
  await assert.rejects(first, /competing live session/);
  const again = tws.snapshot(stock("NVDA", 1));
  await tick();
  gateway.quote("NVDA", 199.9, 200.1);
  assert.equal((await again).bid, 199.9);
  assert.equal(gateway.opened.length, 2);
});

test("tws streams: after a drop the watched stocks stream again on reconnect", async () => {
  const { gateway, tws } = client();
  await tws.watch([stock("AAPL", 1)]);
  gateway.emit(EventName.disconnected);
  const read = tws.snapshot(stock("NVDA", 3));
  await tick();
  await tick();
  assert.equal(gateway.connects, 2);
  assert.deepEqual(
    gateway.opened.map((o) => o.symbol),
    ["AAPL", "AAPL", "NVDA"],
  );
  gateway.quote("NVDA", 1, 1.1);
  await read;
});
