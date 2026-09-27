import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../apps/api/src/worker.js";
import { readWatchlist } from "../packages/market-data/src/watchlist.js";

test("watchlist secret is served; invalid or missing falls back to the default", async () => {
  const secret = JSON.stringify({
    name: "Favorites",
    syncedAt: "2026-09-27T08:00:00Z",
    tickers: ["NVDA", "AAPL", "NVDA"],
  });
  const response = await worker.fetch(
    new Request("https://example.test/api/watchlist"),
    { WATCHLIST: secret },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    source: "ibkr",
    name: "Favorites",
    syncedAt: "2026-09-27T08:00:00Z",
    tickers: ["NVDA", "AAPL"],
  });
  for (const raw of [
    undefined,
    "{",
    '{"tickers":[]}',
    '{"tickers":["ES@CME"]}',
  ]) {
    const list = readWatchlist(raw);
    assert.equal(list.source, "default", String(raw));
    assert.ok(list.tickers.length > 0);
  }
  const post = await worker.fetch(
    new Request("https://example.test/api/watchlist", { method: "POST" }),
  );
  assert.equal(post.status, 405);
});
