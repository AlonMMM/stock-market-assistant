// SYNTHETIC tickers and prices.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../apps/api/src/worker.js";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";
import {
  alpacaLastPrices,
  checkPriceAlerts,
  D1PriceAlerts,
  handlePriceAlerts,
  priceAlertMessage,
  type LastPrice,
  type PriceAlert,
} from "../packages/market-data/src/price-alerts.js";

const setup = () => {
  const store = new D1PriceAlerts(new SqliteD1(":memory:"));
  const call = (method: string, sub: string, body?: unknown, ticker?: string) =>
    handlePriceAlerts(
      method,
      sub,
      { ticker: ticker ?? null },
      body,
      store,
      1000,
    );
  return { store, call };
};

test("price alerts: create, list by stock, delete, refusals", async () => {
  const { call } = setup();
  const made = await call("POST", "", {
    ticker: "nvda",
    kind: "above",
    value: 220,
    note: "breakout",
  });
  assert.equal(made.status, 201);
  const a = made.body as PriceAlert;
  assert.deepEqual(
    [a.ticker, a.kind, a.value, a.note, a.firedAt],
    ["NVDA", "above", 220, "breakout", null],
  );
  await call("POST", "", { ticker: "AAPL", kind: "down", value: 3 });
  const nvda = (await call("GET", "", undefined, "nvda")).body as {
    alerts: PriceAlert[];
  };
  assert.deepEqual(
    nvda.alerts.map((x) => x.ticker),
    ["NVDA"],
  );
  for (const body of [
    { ticker: "BAD$", kind: "above", value: 1 },
    { ticker: "NVDA", kind: "sideways", value: 1 },
    { ticker: "NVDA", kind: "above", value: 0 },
    { ticker: "NVDA", kind: "up", value: 150 },
    { ticker: "NVDA", kind: "above", value: 1, note: "x".repeat(81) },
  ])
    assert.equal((await call("POST", "", body)).status, 400);
  assert.equal((await call("DELETE", a.id)).status, 200);
  assert.equal((await call("DELETE", "../x")).status, 404);
  const all = (await call("GET", "")).body as { alerts: PriceAlert[] };
  assert.deepEqual(
    all.alerts.map((x) => x.ticker),
    ["AAPL"],
  );
});

test("price alerts: each is sent once when met; a failed send stays armed", async () => {
  const { store, call } = setup();
  for (const body of [
    { ticker: "NVDA", kind: "above", value: 220 },
    { ticker: "NVDA", kind: "below", value: 200 },
    { ticker: "AAPL", kind: "up", value: 2 },
    { ticker: "TSLA", kind: "down", value: 5 },
  ])
    await call("POST", "", body);
  let prices = new Map<string, LastPrice>([
    ["NVDA", { last: 221, previousClose: 215 }],
    ["AAPL", { last: 101, previousClose: 100 }], // +1%: not yet
    ["TSLA", { last: 94, previousClose: 100 }], // −6%
  ]);
  const sent: string[] = [];
  let up = true;
  const run = () =>
    checkPriceAlerts({
      store,
      prices: async () => prices,
      send: async (html) => {
        if (!up) return false;
        sent.push(html);
        return true;
      },
      now: 5000,
      siteUrl: "https://site.test/",
    });
  assert.equal(await run(), "4 armed, 2 sent");
  assert.equal(sent.length, 2);
  assert.match(
    sent[0]!,
    /Price alert: \$NVDA[\s\S]*221.00, at or above 220.00/,
  );
  assert.match(sent[0]!, /href="https:\/\/site.test\/#watchlist\/NVDA"/);
  // Sent once: the next minute they are not sent again.
  assert.equal(await run(), "2 armed, 0 sent");
  // Telegram down: the met alert stays armed and goes out once it is back.
  prices = new Map([["AAPL", { last: 103, previousClose: 100 }]]);
  up = false;
  assert.equal(await run(), "2 armed, 0 sent, 1 not sent");
  up = true;
  assert.equal(await run(), "2 armed, 1 sent");
  // A fired alert can be armed again.
  const fired = (await store.list("NVDA")).find((a) => a.kind === "above")!;
  assert.deepEqual([fired.firedAt, fired.firedPrice], [5000, 221]);
  await call("POST", `${fired.id}/rearm`);
  assert.equal((await store.list("NVDA"))[0]!.firedAt, null);
});

test("price alert message: the rule, today's move and the note, escaped", () => {
  const html = priceAlertMessage(
    {
      id: "a",
      ticker: "AAPL",
      kind: "down",
      value: 3,
      note: "<earnings>",
      createdAt: 0,
      firedAt: null,
      firedPrice: null,
    },
    { last: 96.5, previousClose: 100 },
  );
  assert.equal(
    html,
    "<b>Price alert: $AAPL</b>\n96.50, down 3% or more today · −3.50% today\n&lt;earnings&gt;",
  );
});

test("price alerts: last trades from one Alpaca snapshots request", async () => {
  let asked = "";
  const prices = await alpacaLastPrices(
    ["NVDA", "AAPL"],
    { key: "k", secret: "s" },
    (async (url: string | URL) => {
      asked = String(url);
      return Response.json({
        NVDA: { latestTrade: { p: 213.5 }, prevDailyBar: { c: 217 } },
        AAPL: null,
      });
    }) as typeof fetch,
  );
  assert.match(asked, /snapshots\?symbols=NVDA%2CAAPL&feed=sip/);
  assert.deepEqual(
    [...prices],
    [["NVDA", { last: 213.5, previousClose: 217 }]],
  );
});

test("price alerts on the hosted site", async () => {
  const env = { BARS_CACHE: new SqliteD1(":memory:") };
  const made = await worker.fetch(
    new Request("https://example.test/api/price-alerts", {
      method: "POST",
      body: JSON.stringify({ ticker: "NVDA", kind: "up", value: 4 }),
    }),
    env,
  );
  assert.equal(made.status, 201);
  const list = await worker.fetch(
    new Request("https://example.test/api/price-alerts?ticker=NVDA"),
    env,
  );
  const body = (await list.json()) as { alerts: PriceAlert[] };
  assert.equal(body.alerts[0]!.kind, "up");
});
