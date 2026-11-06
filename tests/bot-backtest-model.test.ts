import { test } from "node:test";
import assert from "node:assert/strict";
import { pricedReturn } from "../apps/web/src/bot-backtest-model.js";

test("pricedReturn (2026-11-06): no return under a 5-cent buy", () => {
  assert.equal(pricedReturn(19, 0.01), null);
  assert.equal(pricedReturn(0.5, 0.05), 0.5);
  assert.equal(pricedReturn(0.5, null), 0.5);
  assert.equal(pricedReturn(null, 0.2), null);
});
