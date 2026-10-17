// SYNTHETIC symbols and empty market data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../apps/api/src/app.js";
import worker from "../apps/api/src/worker.js";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";
import { D1SymbolList } from "../packages/market-data/src/backtest-symbols.js";
import {
  D1Watchlists,
  handleWatchlists,
  maxWatchlists,
  type Watchlist,
} from "../packages/market-data/src/watchlists.js";

function setup() {
  const store = new D1Watchlists(new SqliteD1(":memory:"));
  const engine = async () => ["AAPL", "NVDA"];
  const call = (method: string, sub: string, body?: unknown) =>
    handleWatchlists(method, sub, body, store, engine, 1000);
  return { store, call };
}

test("watchlists: create, list with the engine list first, rename, delete", async () => {
  const { call } = setup();
  const empty = await call("GET", "");
  assert.deepEqual(empty.body, {
    lists: [
      { id: "all", name: "All", tickers: ["AAPL", "NVDA"], builtIn: true },
    ],
  });
  const tech = await call("POST", "", {
    name: "  Tech   leaders ",
    tickers: ["msft", "AAPL", "MSFT", "brk.b"],
  });
  assert.equal(tech.status, 201);
  const made = tech.body as Watchlist;
  assert.equal(made.name, "Tech leaders");
  // Upper-cased, unique, in the order given.
  assert.deepEqual(made.tickers, ["MSFT", "AAPL", "BRK.B"]);
  const energy = (await call("POST", "", { name: "Energy" })).body as Watchlist;
  assert.deepEqual(energy.tickers, []);

  const lists = (await call("GET", "")).body as { lists: Watchlist[] };
  assert.deepEqual(
    lists.lists.map((l) => l.name),
    ["All", "Tech leaders", "Energy"],
  );
  const renamed = await call("PATCH", made.id, { name: "Tech" });
  assert.equal((renamed.body as Watchlist).name, "Tech");
  assert.equal((await call("DELETE", energy.id)).status, 200);
  assert.equal((await call("GET", energy.id)).status, 404);
});

test("watchlists: add, remove, replace and reorder symbols", async () => {
  const { call } = setup();
  const a = (await call("POST", "", { name: "A", tickers: ["AMD"] }))
    .body as Watchlist;
  const b = (await call("POST", "", { name: "B" })).body as Watchlist;
  let list = (await call("PATCH", a.id, { add: ["tsm", "AMD", "ARM"] }))
    .body as Watchlist;
  assert.deepEqual(list.tickers, ["AMD", "TSM", "ARM"]);
  list = (await call("PATCH", a.id, { remove: ["TSM"] })).body as Watchlist;
  assert.deepEqual(list.tickers, ["AMD", "ARM"]);
  // `tickers` replaces the list, in that order.
  list = (await call("PATCH", a.id, { tickers: ["ARM", "AMD"] }))
    .body as Watchlist;
  assert.deepEqual(list.tickers, ["ARM", "AMD"]);

  const ordered = (await call("POST", "order", { ids: [b.id, a.id] })).body as {
    lists: Watchlist[];
  };
  assert.deepEqual(
    ordered.lists.map((l) => l.name),
    ["All", "B", "A"],
  );
  assert.equal(
    (await call("POST", "order", { ids: [b.id, b.id] })).status,
    400,
  );
});

test("watchlists: refusals", async () => {
  const { call } = setup();
  const a = (await call("POST", "", { name: "Swing" })).body as Watchlist;
  assert.equal((await call("POST", "", { name: "swing" })).status, 409);
  assert.equal((await call("POST", "", { name: "All" })).status, 409);
  assert.equal((await call("POST", "", { name: "" })).status, 400);
  assert.equal((await call("POST", "", { name: "x".repeat(41) })).status, 400);
  assert.equal(
    (await call("POST", "", { name: "Bad", tickers: ["BAD$"] })).status,
    400,
  );
  assert.equal((await call("PATCH", a.id, {})).status, 400);
  assert.equal((await call("PATCH", a.id, { add: "AAPL" })).status, 400);
  assert.equal(
    (
      await call("PATCH", a.id, {
        tickers: Array.from(
          { length: 201 },
          (_, i) =>
            `A${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`,
        ),
      })
    ).status,
    400,
  );
  // The engine list is changed where it always was.
  assert.equal((await call("PATCH", "all", { add: ["AMD"] })).status, 409);
  assert.equal((await call("GET", "../x")).status, 404);
  assert.equal(
    (await handleWatchlists("GET", "", undefined, undefined, async () => []))
      .status,
    503,
  );
  for (let i = 1; i < maxWatchlists; i++)
    assert.equal((await call("POST", "", { name: `L${i}` })).status, 201);
  assert.equal((await call("POST", "", { name: "One more" })).status, 409);
});

test("the board shows one watchlist with ?list=, locally and hosted", async (t) => {
  const db = new SqliteD1(":memory:");
  const symbols = new D1SymbolList(db);
  await symbols.change(["AAPL", "PLUG"], [], "stock");
  const fetcher = (async () =>
    Response.json({ bars: {}, next_page_token: null })) as typeof fetch;
  t.mock.method(globalThis, "fetch", fetcher);
  const watchlists = new D1Watchlists(db);
  const app = buildApp(false, {
    key: "synthetic",
    secret: "synthetic",
    symbols,
    watchlists,
    fetcher,
  });
  t.after(() => app.close());
  const env = {
    BARS_CACHE: db,
    ALPACA_API_KEY: "synthetic",
    ALPACA_API_SECRET: "synthetic",
  };
  const created = await worker.fetch(
    new Request("https://example.test/api/watchlists", {
      method: "POST",
      body: JSON.stringify({ name: "Chips", tickers: ["NVDA", "AMD"] }),
    }),
    env,
  );
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as Watchlist;

  const local = await app.inject({
    method: "GET",
    url: `/api/board?list=${id}`,
  });
  const hosted = await worker.fetch(
    new Request(`https://example.test/api/board?list=${id}`),
    env,
  );
  assert.deepEqual(local.json().watchlist, ["NVDA", "AMD"]);
  assert.deepEqual(
    ((await hosted.json()) as { watchlist: string[] }).watchlist,
    ["NVDA", "AMD"],
  );
  // No list, or "all": the engine list, as before.
  const all = await worker.fetch(
    new Request("https://example.test/api/board?list=all"),
    env,
  );
  assert.deepEqual(((await all.json()) as { watchlist: string[] }).watchlist, [
    "AAPL",
    "PLUG",
  ]);
  const missing = await worker.fetch(
    new Request("https://example.test/api/board?list=nosuchlist00"),
    env,
  );
  assert.equal(missing.status, 404);

  // The local server edits the same lists.
  const patched = await app.inject({
    method: "PATCH",
    url: `/api/watchlists/${id}`,
    payload: { remove: ["AMD"] },
  });
  assert.equal(patched.statusCode, 200);
  const listed = await worker.fetch(
    new Request("https://example.test/api/watchlists"),
    env,
  );
  const lists = ((await listed.json()) as { lists: Watchlist[] }).lists;
  assert.deepEqual(lists[0]!.tickers, ["AAPL", "PLUG"]);
  assert.deepEqual(lists[1]!.tickers, ["NVDA"]);
});
