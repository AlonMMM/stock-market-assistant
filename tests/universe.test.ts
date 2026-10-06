import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AlpacaUniverse,
  optionSpread,
  screenStock,
} from "../packages/market-data/src/universe.js";

const bars = Array.from({ length: 20 }, (_, i) => ({
  t: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
  c: 50,
  v: 1_000_000,
  vw: 50,
}));
test("liquidity requires price, normal share volume and normal dollar volume", () => {
  assert.equal(screenStock("A", bars, "2026-09-20").eligible, true);
  assert.equal(
    screenStock(
      "A",
      bars.map((b) => ({ ...b, c: 9 })),
      "2026-09-20",
    ).eligible,
    false,
  );
  assert.equal(
    screenStock(
      "A",
      bars.map((b) => ({ ...b, v: 999_999 })),
      "2026-09-20",
    ).eligible,
    false,
  );
  assert.equal(
    screenStock(
      "A",
      bars.map((b) => ({ ...b, vw: 49 })),
      "2026-09-20",
    ).eligible,
    false,
  );
  assert.equal(screenStock("A", bars.slice(1), "2026-09-20").eligible, false);
  assert.equal(screenStock("A", bars, "2026-09-21").eligible, false);
  const future = [...bars, { t: "2026-09-21T00:00:00Z", c: 1, v: 1 }];
  assert.deepEqual(
    screenStock("A", future, "2026-09-20"),
    screenStock("A", bars, "2026-09-20"),
  );
});
test("spread uses midpoint and rejects stale, crossed, zero bids or empty sizes", () => {
  const now = Date.parse("2026-10-06T18:00:00Z");
  const quote = {
    bp: 1.95,
    ap: 2.05,
    bs: 10,
    as: 10,
    t: new Date(now).toISOString(),
  };
  assert.equal(optionSpread(quote, now).eligible, true);
  assert.equal(
    optionSpread({ ...quote, bp: 0.95, ap: 1.05 }, now).eligible,
    false,
  );
  assert.equal(
    optionSpread({ ...quote, bp: 10, ap: 10.2 }, now).eligible,
    false,
  );
  assert.equal(optionSpread({ ...quote, bp: 0 }, now).eligible, false);
  assert.equal(optionSpread({ ...quote, bs: 0 }, now).eligible, false);
  assert.equal(optionSpread({ ...quote, ap: 1 }, now).eligible, false);
  assert.equal(
    optionSpread({ ...quote, t: new Date(now - 60_001).toISOString() }, now)
      .eligible,
    false,
  );
  assert.equal(optionSpread(undefined, now).eligible, false);
});
test("asset discovery supports Alpaca's current and legacy option attributes", async () => {
  const client = new AlpacaUniverse("key", "secret", async () =>
    Response.json([
      {
        symbol: "A",
        tradable: true,
        status: "active",
        attributes: ["has_options"],
      },
      {
        symbol: "B",
        tradable: true,
        status: "active",
        attributes: ["options_enabled"],
      },
      {
        symbol: "C",
        tradable: false,
        status: "active",
        attributes: ["has_options"],
      },
    ]),
  );
  assert.deepEqual(
    (await client.optionableAssets()).map((a) => a.symbol),
    ["A", "B"],
  );
});
test("option chains paginate with explicit OPRA and 7–30 DTE dates", async () => {
  const urls: URL[] = [];
  const client = new AlpacaUniverse("key", "secret", async (input) => {
    urls.push(new URL(String(input)));
    return Response.json(
      urls.length === 1
        ? { snapshots: { A: {} }, next_page_token: "next" }
        : { snapshots: { B: {} } },
    );
  });
  assert.deepEqual(
    Object.keys(await client.optionChain("AAPL", "2026-10-13", "2026-11-05")),
    ["A", "B"],
  );
  assert.equal(urls[1]!.searchParams.get("page_token"), "next");
  assert.equal(urls[0]!.searchParams.get("feed"), "opra");
  assert.equal(urls[0]!.searchParams.get("expiration_date_lte"), "2026-11-05");
});

test("list screen preserves ETFs and missing history; preview never deletes", async () => {
  const { handleSymbolScreen } =
    await import("../packages/market-data/src/screen-symbols.js");
  const { D1SymbolList } =
    await import("../packages/market-data/src/backtest-symbols.js");
  const { SqliteD1 } = await import("../apps/api/src/sqlite-d1.js");
  const { previousSessions } =
    await import("../packages/market-data/src/calendar.js");
  const store = new D1SymbolList(new SqliteD1(":memory:"));
  await store.change(["AAPL", "PLUG", "MISSING"], [], "stock");
  await store.change(["ETF"], [], "etf");
  const dates = [...previousSessions("2026-10-05", 19), "2026-10-05"];
  const fetcher: typeof fetch = async (input) => {
    assert.ok(
      !new URL(String(input)).searchParams.get("symbols")!.includes("ETF"),
    );
    return Response.json({
      bars: {
        AAPL: dates.map((t) => ({ t, c: 100, v: 2_000_000, vw: 100 })),
        PLUG: dates.map((t) => ({ t, c: 3, v: 10_000_000, vw: 3 })),
      },
    });
  };
  const result = await handleSymbolScreen(
    { key: "k", secret: "s" },
    store,
    fetcher,
    Date.parse("2026-10-06T18:00:00Z"),
  );
  assert.equal(result.status, 200);
  assert.ok("remove" in result.body);
  assert.deepEqual(result.body.remove, ["PLUG"]);
  assert.deepEqual((await store.list()).tickers, [
    "AAPL",
    "ETF",
    "MISSING",
    "PLUG",
  ]);
  assert.equal((await handleSymbolScreen({}, store, fetcher)).status, 503);
});
