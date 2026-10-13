import assert from "node:assert/strict";
import test from "node:test";
import { inTheMoney, priceRowIndex } from "../apps/web/src/chain-model.js";

test("the stock-price row sits between the strikes around the price", () => {
  const strikes = [93.5, 94, 94.25, 94.5, 95];
  assert.equal(priceRowIndex(strikes, 94.26), 3);
  assert.equal(priceRowIndex(strikes, 94.25), 3);
  assert.equal(priceRowIndex(strikes, 90), 0);
  assert.equal(priceRowIndex(strikes, 99), 5);
  assert.equal(priceRowIndex(strikes, null), null);
  assert.equal(priceRowIndex([], 94), null);
});

test("calls are in the money below the price, puts above it", () => {
  assert.equal(inTheMoney("call", 94, 94.26), true);
  assert.equal(inTheMoney("call", 94.5, 94.26), false);
  assert.equal(inTheMoney("put", 94.5, 94.26), true);
  assert.equal(inTheMoney("put", 94, 94.26), false);
  assert.equal(inTheMoney("call", 94, null), false);
});
