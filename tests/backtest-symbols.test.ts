import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../apps/api/src/app.js";
import worker from "../apps/api/src/worker.js";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";
import {
  D1SymbolList,
  handleBacktestSymbols,
  maxListSymbols,
} from "../packages/market-data/src/backtest-symbols.js";

test("the backtest symbol list adds, removes and validates symbols", async () => {
  const store = new D1SymbolList(new SqliteD1(":memory:"));
  const get = () => handleBacktestSymbols("GET", undefined, store);
  assert.deepEqual((await get()).body, { tickers: [] });
  const added = await handleBacktestSymbols(
    "POST",
    { add: [" amd", "ARM", "AMD", "BRK.B"] },
    store,
  );
  assert.equal(added.status, 200);
  assert.deepEqual(added.body, { tickers: ["AMD", "ARM", "BRK.B"] });
  const removed = await handleBacktestSymbols(
    "POST",
    { add: ["TSM"], remove: ["ARM", "NOPE"] },
    store,
  );
  assert.deepEqual(removed.body, { tickers: ["AMD", "BRK.B", "TSM"] });
  for (const body of [
    { add: "AMD" },
    { add: [1] },
    { add: ["not a symbol"] },
  ]) {
    const r = await handleBacktestSymbols("POST", body, store);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const tooMany = Array.from({ length: maxListSymbols }, (_, i) => `S${i}`);
  assert.equal(
    (await handleBacktestSymbols("POST", { add: tooMany }, store)).status,
    400,
  );
  assert.deepEqual((await get()).body, { tickers: ["AMD", "BRK.B", "TSM"] });
  assert.equal((await handleBacktestSymbols("PUT", {}, store)).status, 405);
  assert.equal((await handleBacktestSymbols("GET", undefined)).status, 503);
});

test("local API and hosted Worker serve the same backtest symbol list", async () => {
  const app = buildApp(false, {
    symbols: new D1SymbolList(new SqliteD1(":memory:")),
  });
  const env = { BARS_CACHE: new SqliteD1(":memory:") };
  try {
    const local = await app.inject({
      method: "POST",
      url: "/api/backtest/symbols",
      payload: { add: ["NVDA", "AMD"] },
    });
    const hosted = await worker.fetch(
      new Request("https://example.test/api/backtest/symbols", {
        method: "POST",
        body: JSON.stringify({ add: ["NVDA", "AMD"] }),
      }),
      env,
    );
    assert.equal(local.statusCode, 200);
    assert.equal(hosted.status, 200);
    assert.deepEqual(await hosted.json(), local.json());
    const listed = await worker.fetch(
      new Request("https://example.test/api/backtest/symbols"),
      env,
    );
    assert.deepEqual(await listed.json(), { tickers: ["AMD", "NVDA"] });
    const bad = await worker.fetch(
      new Request("https://example.test/api/backtest/symbols", {
        method: "POST",
        body: "{",
      }),
      env,
    );
    assert.equal(bad.status, 400);
  } finally {
    await app.close();
  }
});
