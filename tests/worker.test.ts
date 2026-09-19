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
