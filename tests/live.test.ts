import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../apps/api/src/worker.js";
import { loadLive } from "../packages/market-data/src/live.js";

const collector = { url: "https://collector.test", token: "t".repeat(64) };
const alert = {
  ticker: "NVDA",
  end: "2026-09-28T14:05:00.000Z",
  session: "regular",
  actual: 90000,
  expected: 20000,
  ratio: 4.5,
  samples: 20,
  status: "alert",
  rule: "rvol-time-of-day-v1",
  config: { window: 5, days: 20, threshold: 3, cooldown: 15, minVolume: 10000 },
  close: 180.5,
};

test("live status summarizes collector health and passes alerts through", async () => {
  const seen: string[] = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    seen.push(
      `${String(input)} ${new Headers(init?.headers).get("Authorization")}`,
    );
    return String(input).endsWith("/health")
      ? Response.json({
          state: "subscribed",
          feed: "iex",
          failure: null,
          symbols: {
            NVDA: { lastBar: "2026-09-28T14:05:00.000Z" },
            AAPL: { lastBar: "2026-09-28T14:04:00.000Z" },
            WIX: { lastBar: null },
          },
        })
      : Response.json({ source: "alpaca", alerts: [alert] });
  }) as typeof fetch;
  const live = await loadLive(collector, fetcher);
  assert.deepEqual(seen.sort(), [
    `https://collector.test/alerts Bearer ${collector.token}`,
    `https://collector.test/health Bearer ${collector.token}`,
  ]);
  assert.equal(live.state, "subscribed");
  assert.equal(live.feed, "iex");
  assert.equal(live.symbols, 3);
  assert.equal(live.receiving, 2);
  assert.equal(live.lastBarAt, "2026-09-28T14:05:00.000Z");
  assert.deepEqual(live.alerts, [alert]);
});

test("live status reports an unreachable or unconfigured collector", async () => {
  assert.equal((await loadLive({})).state, "unavailable");
  const down = await loadLive(
    collector,
    (async () =>
      new Response("no", { status: 401 })) as unknown as typeof fetch,
  );
  assert.equal(down.state, "unavailable");
  assert.equal(down.failure, "Collector HTTP 401");
  const offline = await loadLive(collector, (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch);
  assert.equal(offline.failure, "Live collector is unreachable");
  const response = await worker.fetch(
    new Request("https://example.test/api/live"),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, "unavailable");
  const post = await worker.fetch(
    new Request("https://example.test/api/live", { method: "POST" }),
  );
  assert.equal(post.status, 405);
});
