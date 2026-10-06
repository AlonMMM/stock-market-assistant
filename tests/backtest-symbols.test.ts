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
import { pushLiveSymbols } from "../packages/market-data/src/watchlist.js";

test("the backtest symbol list adds, removes and validates symbols", async () => {
  const store = new D1SymbolList(new SqliteD1(":memory:"));
  const get = () => handleBacktestSymbols("GET", undefined, store);
  assert.deepEqual((await get()).body, { tickers: [], etfs: [] });
  const added = await handleBacktestSymbols(
    "POST",
    { add: [" amd", "ARM", "AMD", "BRK.B"] },
    store,
  );
  assert.equal(added.status, 200);
  assert.deepEqual(added.body, {
    tickers: ["AMD", "ARM", "BRK.B"],
    etfs: [],
  });
  const removed = await handleBacktestSymbols(
    "POST",
    { add: ["TSM"], remove: ["ARM", "NOPE"] },
    store,
  );
  assert.deepEqual(removed.body, {
    tickers: ["AMD", "BRK.B", "TSM"],
    etfs: [],
  });
  // ETFs: added as such, and an existing symbol can be re-marked.
  const etfs = await handleBacktestSymbols(
    "POST",
    { add: ["SPY", "TSM"], kind: "etf" },
    store,
  );
  assert.deepEqual(etfs.body, {
    tickers: ["AMD", "BRK.B", "SPY", "TSM"],
    etfs: ["SPY", "TSM"],
  });
  await handleBacktestSymbols("POST", { add: ["TSM"], kind: "stock" }, store);
  await handleBacktestSymbols("POST", { remove: ["SPY"] }, store);
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
  assert.deepEqual((await get()).body, {
    tickers: ["AMD", "BRK.B", "TSM"],
    etfs: [],
  });
  assert.equal(
    (await handleBacktestSymbols("POST", { add: ["X"], kind: "fund" }, store))
      .status,
    400,
  );
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
    assert.deepEqual(await listed.json(), {
      tickers: ["AMD", "NVDA"],
      etfs: [],
    });
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

test("a list made before kinds existed gains the column", async () => {
  const db = new SqliteD1(":memory:");
  await db
    .prepare(
      "CREATE TABLE backtest_symbols (ticker TEXT PRIMARY KEY, added_at INTEGER NOT NULL)",
    )
    .run();
  await db.prepare("INSERT INTO backtest_symbols VALUES ('AAPL', 1)").run();
  const store = new D1SymbolList(db);
  assert.deepEqual(await store.list(), { tickers: ["AAPL"], etfs: [] });
  await store.change(["QQQ"], [], "etf");
  assert.deepEqual(await store.list(), {
    tickers: ["AAPL", "QQQ"],
    etfs: ["QQQ"],
  });
});

test("a list change is sent to the live collector, which streams it", async () => {
  const store = new D1SymbolList(new SqliteD1(":memory:"));
  const pushed: string[][] = [];
  const push = async (tickers: string[]) => {
    pushed.push(tickers);
    return { synced: true };
  };
  await handleBacktestSymbols("GET", undefined, store, push);
  assert.deepEqual(pushed, [], "reading does not push");
  const added = await handleBacktestSymbols(
    "POST",
    { add: ["NVDA", "AMD"] },
    store,
    push,
  );
  assert.deepEqual(pushed, [["AMD", "NVDA"]]);
  assert.deepEqual((added.body as { live?: unknown }).live, { synced: true });
  // A collector failure is reported but the list change stands.
  const failed = await handleBacktestSymbols(
    "POST",
    { add: ["TSM"] },
    store,
    async () => ({ synced: false, error: "Collector unreachable" }),
  );
  assert.equal(failed.status, 200);
  assert.deepEqual((failed.body as { live?: unknown }).live, {
    synced: false,
    error: "Collector unreachable",
  });
  assert.deepEqual((failed.body as { tickers: string[] }).tickers, [
    "AMD",
    "NVDA",
    "TSM",
  ]);
});

test("pushLiveSymbols sends PUT /live-symbols with the collector token", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const result = await pushLiveSymbols(
    { url: "https://collector.test/", token: "t".repeat(32) },
    ["AMD"],
    fetcher,
  );
  assert.deepEqual(result, { synced: true });
  assert.equal(calls[0]!.url, "https://collector.test/live-symbols");
  assert.equal(calls[0]!.init.method, "PUT");
  assert.equal(calls[0]!.init.body, JSON.stringify({ tickers: ["AMD"] }));
  assert.deepEqual(await pushLiveSymbols({}, ["AMD"], fetcher), {
    synced: false,
    error: "Live collector is not configured",
  });
});

test("removing the final symbol syncs an empty live list", async () => {
  const store = new D1SymbolList(new SqliteD1(":memory:"));
  await store.change(["PLUG"], [], "stock");
  const pushed: string[][] = [];
  const result = await handleBacktestSymbols(
    "POST",
    { remove: ["PLUG"] },
    store,
    async (tickers) => {
      pushed.push(tickers);
      return { synced: true };
    },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(pushed, [[]]);
  assert.deepEqual((result.body as { tickers: string[] }).tickers, []);
});
