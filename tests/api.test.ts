import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../apps/api/src/app.js";
import { isHealthResponse } from "../packages/contracts/src/index.js";

test("health response satisfies the shared web contract and does not claim live data", async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(isHealthResponse(response.json()), true);
});

test("client rejects malformed health payloads", () => {
  for (const value of [
    null,
    {},
    { status: "ok" },
    { status: "ok", service: "other", marketData: "not-connected" },
  ]) {
    assert.equal(isHealthResponse(value), false);
  }
});
