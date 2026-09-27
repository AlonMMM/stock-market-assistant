import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../apps/api/src/worker.js";
import { loadWatchlist } from "../packages/market-data/src/watchlist.js";

const collector = { url: "https://collector.test/", token: "t".repeat(64) };

test("the site serves the collector's synced watchlist", async () => {
  const realFetch = globalThis.fetch;
  const requests: [string, string | null][] = [];
  globalThis.fetch = async (input, init) => {
    requests.push([
      String(input),
      new Headers(init?.headers).get("Authorization"),
    ]);
    return Response.json({
      source: "ibkr",
      name: "Favorites",
      syncedAt: "2026-09-27T08:00:00Z",
      tickers: ["NVDA", "AAPL"],
      live: ["NVDA"],
    });
  };
  try {
    const response = await worker.fetch(
      new Request("https://example.test/api/watchlist"),
      { COLLECTOR_URL: collector.url, COLLECTOR_TOKEN: collector.token },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      source: "ibkr",
      name: "Favorites",
      syncedAt: "2026-09-27T08:00:00Z",
      tickers: ["NVDA", "AAPL"],
      live: ["NVDA"],
    });
    assert.deepEqual(requests, [
      ["https://collector.test/watchlist", `Bearer ${collector.token}`],
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
  const post = await worker.fetch(
    new Request("https://example.test/api/watchlist", { method: "POST" }),
  );
  assert.equal(post.status, 405);
});

test("the default list is served when the collector has none or fails", async () => {
  const answer = (response: Response) =>
    (async () => response) as unknown as typeof fetch;
  for (const fetcher of [
    answer(
      Response.json({ error: "No watchlist synced yet" }, { status: 404 }),
    ),
    answer(Response.json({ name: "X", tickers: ["ES@CME"] })),
    answer(new Response("<!DOCTYPE html>")),
    (async () => {
      throw new Error("offline");
    }) as typeof fetch,
  ]) {
    const list = await loadWatchlist(collector, fetcher);
    assert.equal(list.source, "default");
    assert.ok(list.tickers.length > 0);
  }
  assert.equal((await loadWatchlist({})).source, "default");
});
