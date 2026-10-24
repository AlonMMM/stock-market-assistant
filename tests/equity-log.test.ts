import assert from "node:assert/strict";
import test from "node:test";
import { EquityLog } from "../apps/trader/src/equity-log.js";
import { ensureOwnerIbkr, seedOwner } from "../apps/trader/src/seed.js";
import { TradeStore } from "../apps/trader/src/store.js";
import { Traders, type Trader } from "../apps/trader/src/traders.js";
import type { TwsClient } from "../packages/trading/src/ibkr-trading.js";

// The service's own daily equity history for brokers without one (IBKR), the
// series the risk manager's drawdown brake reads (docs/tasks/backend-bot-ibkr.md).
// Synthetic account values; no broker is contacted.

const tuesday11 = Date.parse("2026-10-13T15:00:00Z"); // 11:00 New York, open
const tuesday8 = Date.parse("2026-10-13T12:00:00Z"); // 08:00, before the open
const tuesday17 = Date.parse("2026-10-13T21:00:00Z"); // 17:00, after the close
const saturday = Date.parse("2026-10-17T15:00:00Z");
const env = {
  ALPACA_API_KEY: "synthetic-key",
  ALPACA_API_SECRET: "synthetic-secret",
};

function trader(
  ownEquityHistory: boolean | undefined,
  equity: () => Promise<number>,
): Trader {
  return {
    scope: "owner/owner-ibkr",
    account: { id: "owner-ibkr", broker: "ibkr" },
    broker: {
      capabilities: {
        paper: true,
        closeOnlyOrders: false,
        optionStops: true,
        replaceInPlace: true,
        ...(ownEquityHistory === undefined ? {} : { ownEquityHistory }),
      },
      equity,
    },
  } as unknown as Trader;
}

test("store: one equity row per account and day, the last write wins, oldest first", () => {
  const store = new TradeStore(":memory:");
  store.recordEquity("a", "2026-10-13", 100_000, 1);
  store.recordEquity("a", "2026-10-12", 98_000, 2);
  store.recordEquity("a", "2026-10-13", 101_500, 3);
  store.recordEquity("b", "2026-10-13", 5, 4);
  assert.deepEqual(store.equityDays("a"), [
    { date: "2026-10-12", equity: 98_000 },
    { date: "2026-10-13", equity: 101_500 },
  ]);
  assert.deepEqual(store.equityDays("none"), []);
});

test("equity log: records IBKR on trading days from the open, skips the rest", async () => {
  const store = new TradeStore(":memory:");
  const lines: string[] = [];
  const clock = { now: tuesday11 };
  const log = new EquityLog(
    store,
    (l) => lines.push(l),
    () => clock.now,
  );
  let value = 100_000;
  const ibkr = trader(false, async () => value);
  // A broker with its own history (Alpaca) is not recorded.
  assert.equal(EquityLog.keeps(trader(undefined, async () => 1)), false);
  assert.equal(await log.record(trader(undefined, async () => 1)), null);
  assert.equal(await log.record(trader(true, async () => 1)), null);
  // Before the open: nothing yet (the value is yesterday's).
  clock.now = tuesday8;
  assert.equal(await log.record(ibkr), null);
  // Open: today's row; later writes replace it, the last is the close.
  clock.now = tuesday11;
  assert.equal(await log.record(ibkr), 100_000);
  value = 97_250;
  clock.now = tuesday17;
  assert.equal(await log.record(ibkr), 97_250);
  assert.deepEqual(store.equityDays("owner-ibkr"), [
    { date: "2026-10-13", equity: 97_250 },
  ]);
  // A weekend adds no day.
  clock.now = saturday;
  assert.equal(await log.record(ibkr), null);
  // A failed or empty read is logged, never written.
  clock.now = tuesday17;
  value = 0;
  assert.equal(await log.record(ibkr), null);
  assert.match(lines.at(-1)!, /not recorded/);
  await assert.rejects(
    log.record(
      trader(false, async () => {
        throw new Error("Gateway down");
      }),
    ),
    /Gateway down/,
  );
  assert.equal(store.equityDays("owner-ibkr").length, 1);
});

test("traders: the IBKR broker's equity history is the service's record", async () => {
  const store = new TradeStore(":memory:");
  seedOwner(store, env, tuesday11);
  ensureOwnerIbkr(store, { IBKR_GATEWAY: "gw:4001" }, tuesday11);
  const traders = new Traders({
    store,
    secrets: { env },
    enabled: true,
    log: () => {},
    makeTws: () => ({}) as TwsClient,
  });
  const account = store.accounts("owner").find((a) => a.broker === "ibkr")!;
  const broker = traders.broker(account);
  assert.equal(broker.capabilities.ownEquityHistory, false);
  assert.deepEqual(await broker.equityHistory(), []);
  store.recordEquity(account.id, "2026-10-12", 100_000, 1);
  store.recordEquity(account.id, "2026-10-13", 90_000, 2);
  assert.deepEqual(await broker.equityHistory(), [
    { date: "2026-10-12", equity: 100_000 },
    { date: "2026-10-13", equity: 90_000 },
  ]);
});
