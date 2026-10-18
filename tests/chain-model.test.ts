import assert from "node:assert/strict";
import test from "node:test";
import {
  daysLabel,
  daysToExpiry,
  expiryTab,
  inTheMoney,
  isMonthly,
  pairStrikes,
  priceRowIndex,
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

test("calls and puts are joined by strike, a missing side left empty", () => {
  const calls = [{ strike: 95 }, { strike: 94 }];
  const puts = [{ strike: 94 }, { strike: 93.5 }];
  assert.deepEqual(pairStrikes(calls, puts), [
    { strike: 93.5, call: null, put: { strike: 93.5 } },
    { strike: 94, call: { strike: 94 }, put: { strike: 94 } },
    { strike: 95, call: { strike: 95 }, put: null },
  ]);
  assert.deepEqual(pairStrikes([], []), []);
});

test("days to expiry count from today's date in New York", () => {
  // 2026-10-17 02:00 UTC is still Oct 16 in New York.
  const lateFriday = Date.parse("2026-10-17T02:00:00Z");
  assert.equal(daysToExpiry("2026-10-16", lateFriday), 0);
  assert.equal(daysToExpiry("2026-10-19", lateFriday), 3);
  const saturday = Date.parse("2026-10-17T15:00:00Z");
  assert.equal(daysToExpiry("2026-10-19", saturday), 2);
  assert.equal(daysLabel(0), "today");
  assert.equal(daysLabel(1), "1 day");
  assert.equal(daysLabel(13), "13 days");
});

test("expiry tabs: monthly third Fridays and weeklies", () => {
  assert.equal(isMonthly("2026-10-16"), true); // third Friday of October
  assert.equal(isMonthly("2026-10-23"), false);
  assert.equal(isMonthly("2026-10-19"), false); // a Monday
  assert.equal(isMonthly("2026-11-20"), true);
  assert.equal(expiryTab("2026-10-19"), "Oct 19 '26");
});
