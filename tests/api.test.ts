import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../apps/api/src/app.js";
import { isHealthResponse } from "../packages/contracts/src/index.js";
import { parseSipDelay } from "../packages/market-data/src/sip-delay.js";

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

test("ALPACA_SIP_DELAY_MINUTES parses to 0–60 minutes, default 0", () => {
  assert.equal(parseSipDelay(undefined), 0);
  assert.equal(parseSipDelay(""), 0);
  assert.equal(parseSipDelay("15"), 15);
  assert.equal(parseSipDelay(" 0 "), 0);
  for (const bad of ["-1", "61", "1.5", "fifteen"])
    assert.throws(() => parseSipDelay(bad), /ALPACA_SIP_DELAY_MINUTES/);
});
