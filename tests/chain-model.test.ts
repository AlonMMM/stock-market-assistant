import assert from "node:assert/strict";
import test from "node:test";
import {
  inTheMoney,
  onOptionTick,
  priceRowIndex,
  stepOptionPrice,
} from "../apps/web/src/chain-model.js";

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

test("a chain without the price field shows no price row", () => {
  // A trading service from before `underlyingPrice` omits it.
  const missing = ({} as { underlyingPrice?: number | null }).underlyingPrice;
  assert.equal(priceRowIndex([94, 95], missing ?? null), null);
  assert.equal(inTheMoney("put", 95, missing ?? null), false);
});

test("option prices keep to the tick", () => {
  assert.equal(onOptionTick(1.234), 1.23);
  assert.equal(onOptionTick(3.12), 3.1);
  assert.equal(stepOptionPrice(2.99, true), 3);
  assert.equal(stepOptionPrice(3, true), 3.05);
  assert.equal(stepOptionPrice(3, false), 2.99);
  assert.equal(stepOptionPrice(0.01, false), 0.01);
});
