import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";
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

function client(
  options: {
    streamLines?: number;
    pinnedLines?: number;
    quoteMs?: number;
  } = {},
) {
  const gateway = new FakeGateway();
  const tws = new StoqeyTws({
    host: "gateway",
    port: 4001,
    clientId: 1,
    quoteMs: options.quoteMs ?? 200,
    ...(options.streamLines ? { streamLines: options.streamLines } : {}),
    ...(options.pinnedLines !== undefined
      ? { pinnedLines: options.pinnedLines }
      : {}),
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
  const { gateway, tws } = client({ streamLines: 3, pinnedLines: 2 });
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

// 2026-11-05 15:00 UTC = 10:00 in New York.
const tenAm = Date.parse("2026-11-05T15:00:00Z");
const minutes = (n: number) => n * 60_000;

test("tws streams: the 30-minute volume is the day volume now less 30 minutes ago, once a stream has watched the whole window", async () => {
  mock.timers.enable({ apis: ["Date"], now: tenAm });
  try {
    const { gateway, tws } = client();
    await tws.watch([option], "options");
    const req = gateway.reqOf("NVDA200");
    const volume = (v: number) => gateway.emit(EventName.tickSize, req, 8, v);
    volume(1000);
    mock.timers.setTime(tenAm + minutes(10));
    volume(1200);
    // 20 minutes of watching: not a whole window yet.
    mock.timers.setTime(tenAm + minutes(20));
    assert.equal(tws.streamVolume(option, Date.now(), 30), null);
    mock.timers.setTime(tenAm + minutes(35));
    volume(1500);
    // From 10:05 (1000 then) to 10:35: 500.
    assert.equal(tws.streamVolume(option, Date.now(), 30), 500);
    // Another field (the bid's size) is not the volume.
    gateway.emit(EventName.tickSize, req, 0, 7);
    assert.equal(tws.streamVolume(option, Date.now(), 30), 500);
    // A contract with no stream: ask the history.
    assert.equal(
      tws.streamVolume({ ...option, conId: 901 }, Date.now(), 30),
      null,
    );
  } finally {
    mock.timers.reset();
  }
});

test("tws streams: a new session's count never spans the reset or the day before", async () => {
  mock.timers.enable({ apis: ["Date"], now: tenAm });
  try {
    const { gateway, tws } = client();
    await tws.watch([option], "options");
    const req = gateway.reqOf("NVDA200");
    gateway.emit(EventName.tickSize, req, 8, 5000);
    // The next morning the count starts again.
    const next = tenAm + minutes(24 * 60);
    mock.timers.setTime(next);
    gateway.emit(EventName.tickSize, req, 8, 40);
    mock.timers.setTime(next + minutes(10));
    assert.equal(tws.streamVolume(option, Date.now(), 30), null);
    mock.timers.setTime(next + minutes(31));
    gateway.emit(EventName.tickSize, req, 8, 300);
    assert.equal(tws.streamVolume(option, Date.now(), 30), 260);
  } finally {
    mock.timers.reset();
  }
});

test("tws streams: the kept options get the lines the watched stocks leave", async () => {
  const { gateway, tws } = client({ streamLines: 10, pinnedLines: 3 });
  await tws.watch([stock("AAPL", 1), stock("MSFT", 2)]);
  await tws.watch([option, { ...option, conId: 901, strike: 205 }], "options");
  assert.deepEqual(
    gateway.opened.map((o) => o.symbol),
    ["AAPL", "MSFT", "NVDA200"],
  );
});
