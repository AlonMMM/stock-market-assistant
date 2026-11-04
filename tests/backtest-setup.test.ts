import assert from "node:assert/strict";
import test from "node:test";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";
import { changeRefusal } from "../apps/api/src/owner-only.js";
import {
  D1BacktestSetups,
  handleBacktestSetup,
} from "../packages/market-data/src/backtest-setup.js";

test("the Backtest page's setup is kept per viewer on the server, the same on every device", async () => {
  const store = new D1BacktestSetups(new SqliteD1(":memory:"));
  const call = (method: string, owner: string, body?: unknown) =>
    handleBacktestSetup({ method, body, owner, store, now: 1000 });
  assert.equal((await call("GET", "me@example.com")).status, 404);
  const setup = { bot: "main", tickers: ["NVDA"], money: { sizePct: 5 } };
  const put = await call("PUT", "me@example.com", { setup });
  assert.equal(put.status, 200);
  // Another device of the same viewer reads it back.
  const got = await call("GET", "me@example.com");
  assert.deepEqual(got, { status: 200, body: { setup, savedAt: 1000 } });
  // A second save replaces it; another viewer has none of it.
  await call("PUT", "me@example.com", {
    setup: { ...setup, tickers: ["AMD"] },
  });
  assert.deepEqual(
    (
      (await call("GET", "me@example.com")).body as {
        setup: { tickers: string[] };
      }
    ).setup.tickers,
    ["AMD"],
  );
  assert.equal((await call("GET", "you@example.com")).status, 404);
  assert.equal(
    (await call("PUT", "me@example.com", { setup: [] })).status,
    400,
  );
  assert.equal((await call("PUT", "me@example.com", {})).status, 400);
  assert.equal((await call("POST", "me@example.com", { setup })).status, 405);
  const big = { setup: { x: "a".repeat(70000) } };
  assert.equal((await call("PUT", "me@example.com", big)).status, 413);
  assert.equal(
    (
      await handleBacktestSetup({
        method: "GET",
        body: null,
        owner: "",
        store: undefined,
      })
    ).status,
    503,
  );
});

test("any viewer may save their own Backtest setup (not an owner setting)", () => {
  const viewer = { email: "viewer@example.com" } as Parameters<
    typeof changeRefusal
  >[2];
  assert.equal(
    changeRefusal("PUT", "/api/backtest-setup", viewer, "owner@example.com"),
    null,
  );
});
