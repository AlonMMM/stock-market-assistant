import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../apps/api/src/worker.js";
import { buildApp } from "../apps/api/src/app.js";
test("hosted replay matches the local API and rejects malformed and oversized bodies", async () => {
  const app = buildApp();
  try {
    const local = await app.inject({
      method: "POST",
      url: "/api/replay",
      payload: {},
    });
    const hosted = await worker.fetch(
      new Request("https://example.test/api/replay", {
        method: "POST",
        body: "{}",
      }),
    );
    assert.deepEqual(await hosted.json(), local.json());
    for (const [body, status] of [
      ["null", 400],
      ["{", 400],
      [" ".repeat(1048577), 413],
    ] as const) {
      const r = await worker.fetch(
        new Request("https://example.test/api/replay", {
          method: "POST",
          body,
        }),
      );
      assert.equal(r.status, status);
    }
  } finally {
    await app.close();
  }
});

test("the bot's account routes: not connected without its keys; its keys reach the paper account", async () => {
  const missing = await worker.fetch(
    new Request("https://example.test/api/portfolio/bot"),
    {},
  );
  assert.equal(missing.status, 503);
  assert.match(
    ((await missing.json()) as { error: string }).error,
    /BOT_ALPACA_API_KEY/,
  );
  const history = await worker.fetch(
    new Request("https://example.test/api/portfolio/bot/history?period=1W"),
    {},
  );
  assert.equal(history.status, 503);
  // With keys, every Alpaca call carries the bot's key, never the owner's.
  const seen: { url: string; key: string | null }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), key: headers.get("APCA-API-KEY-ID") });
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  try {
    const answer = await worker.fetch(
      new Request("https://example.test/api/portfolio/bot"),
      {
        ALPACA_API_KEY: "owner-key",
        ALPACA_API_SECRET: "owner-secret",
        BOT_ALPACA_API_KEY: "bot-key",
        BOT_ALPACA_API_SECRET: "bot-secret",
      },
    );
    assert.notEqual(answer.status, 503);
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(seen.length > 0);
  assert.ok(
    seen.every((s) => s.key === "bot-key"),
    JSON.stringify(seen),
  );
  assert.ok(seen.some((s) => s.url.includes("paper-api.alpaca.markets")));
});
