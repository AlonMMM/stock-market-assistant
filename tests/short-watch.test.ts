import assert from "node:assert/strict";
import test from "node:test";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";
import {
  D1WatchStore,
  failuresToReport,
  repeatMs,
  watchShort,
} from "../packages/trading/src/watch.js";

// Synthetic account data in Alpaca's response shape.
const account = { equity: "100000", last_equity: "100000", cash: "100000" };
const held = (qty: number) => ({
  symbol: "AMD261016C00660000",
  asset_class: "us_option",
  qty: String(qty),
  avg_entry_price: "1.70",
});

function setup() {
  const state = { positions: [held(2)] as unknown[], down: false };
  const sent: string[] = [];
  const telegram = { ok: true };
  const fetcher = (async (input: URL) => {
    if (state.down) return new Response("", { status: 500 });
    const path = input.pathname;
    return Response.json(
      path === "/v2/account"
        ? account
        : path === "/v2/positions"
          ? state.positions
          : [],
    );
  }) as unknown as typeof fetch;
  const store = new D1WatchStore(new SqliteD1(":memory:"));
  const run = (now: number) =>
    watchShort({
      credentials: { key: "k", secret: "s" },
      store,
      fetcher,
      now,
      send: async (html) => {
        if (telegram.ok) sent.push(html);
        return telegram.ok;
      },
    });
  return { state, sent, telegram, run };
}

test("a clean account sends nothing", async () => {
  const { sent, run } = setup();
  assert.equal(await run(0), "clean");
  assert.deepEqual(sent, []);
});

test("a short position is sent once, repeated after 15 minutes, then cleared", async () => {
  const { state, sent, run } = setup();
  state.positions = [held(-1)];
  await run(1000);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /SHORT OPTION RISK<\/b> \(paper\)\nSHORT AMD261016C/);
  await run(61_000);
  assert.equal(sent.length, 1);
  await run(1000 + repeatMs);
  assert.equal(sent.length, 2);
  state.positions = [held(-2)];
  await run(2000 + repeatMs);
  assert.equal(sent.length, 3);
  state.positions = [];
  await run(3000 + repeatMs);
  assert.match(sent[3]!, /risk is gone/);
  await run(4000 + repeatMs);
  assert.equal(sent.length, 4);
});

test("an alert Telegram refused is tried again on the next check", async () => {
  const { state, sent, telegram, run } = setup();
  state.positions = [held(-1)];
  telegram.ok = false;
  assert.match(await run(0), /^ALERT NOT SENT/);
  telegram.ok = true;
  await run(60_000);
  assert.equal(sent.length, 1);
});

test("a check that keeps failing is reported once, and its recovery too", async () => {
  const { state, sent, run } = setup();
  state.down = true;
  for (let i = 1; i < failuresToReport; i++) await run(i);
  assert.deepEqual(sent, []);
  await run(10);
  assert.match(sent[0]!, /check is failing/);
  await run(11);
  assert.equal(sent.length, 1);
  state.down = false;
  await run(12);
  assert.match(sent[1]!, /works again/);
  assert.equal(sent.length, 2);
});
