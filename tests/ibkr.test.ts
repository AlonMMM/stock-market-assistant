import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EventName, type IBApi } from "@stoqey/ib";
import { IbkrFeed } from "../packages/market-data/src/ibkr.js";

test("IBKR adapter requests minute TRADES outside RTH, separates updates, and fails visibly on entitlement loss", async () => {
  class Transport extends EventEmitter {
    calls: unknown[][] = [];
    connect() {
      this.emit(EventName.nextValidId, 100);
    }
    disconnect() {}
    cancelHistoricalData() {}
    reqHistoricalData(...args: unknown[]) {
      this.calls.push(args);
    }
  }
  const transport = new Transport();
  const failures: string[] = [];
  const feed = new IbkrFeed(
    "127.0.0.1",
    4001,
    (m) => failures.push(m),
    transport as unknown as IBApi,
  );
  await feed.connect();
  const volumes: number[] = [];
  const request = feed.history("AAPL", "", (b) => volumes.push(b.volume));
  assert.deepEqual(transport.calls[0]?.slice(2), [
    "",
    "1 D",
    "1 min",
    "TRADES",
    false,
    2,
    true,
  ]);
  transport.emit(EventName.historicalData, 1, "1789743600", 10, 12, 9, 11, 100);
  transport.emit(EventName.historicalData, 1, "finished-start-end");
  assert.equal((await request)[0]?.volume, 100);
  transport.emit(
    EventName.historicalDataUpdate,
    1,
    "1789743600",
    10,
    12,
    9,
    11,
    150,
  );
  assert.deepEqual(volumes, [150]);
  const failed = feed.history("MSFT", "20260918-01:00:00");
  transport.emit(
    EventName.error,
    new Error("sensitive broker payload"),
    354,
    2,
  );
  await assert.rejects(failed, /IBKR error 354/);
  assert.deepEqual(failures, ["IBKR error 354, request 2"]);
  await assert.rejects(feed.history("AAPL", ""), /unavailable/);
  feed.close();
});
