// SYNTHETIC option marks and prices: model checks only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blackScholes,
  estimateOption,
  expiryTime,
  impliedVolatility,
} from "../packages/trading/src/option-estimate.js";

const close = (a: number, b: number, tolerance = 1e-3) =>
  assert.ok(Math.abs(a - b) < tolerance, `${a} is not ${b}`);

test("black-scholes matches the textbook call and put", () => {
  // S = K = 100, one year, σ 20%, r 5%.
  close(blackScholes("call", 100, 100, 1, 0.2, 0.05), 10.4506);
  close(blackScholes("put", 100, 100, 1, 0.2, 0.05), 5.5735);
  close(impliedVolatility("call", 10.4506, 100, 100, 1, 0.05)!, 0.2);
  // Expired: intrinsic only.
  assert.equal(blackScholes("put", 90, 100, 0, 0.3), 10);
  // A price below intrinsic has no volatility.
  assert.equal(impliedVolatility("call", 1, 120, 100, 0.1), null);
});

test("options expire at the US options close in New York", () => {
  assert.equal(expiryTime("2026-10-16"), Date.parse("2026-10-16T20:00:00Z"));
  // Early close the day after Thanksgiving.
  assert.equal(expiryTime("2026-11-27"), Date.parse("2026-11-27T18:00:00Z"));
});

const markAt = Date.parse("2026-10-12T20:00:00Z"); // Monday close
const base = {
  right: "call" as const,
  strike: 720,
  expiry: "2026-10-16",
  mark: 2.1,
  markAt,
  reference: 690,
  impliedVolatility: 0.35,
  greeks: { delta: 0.2, gamma: 0.02, theta: -0.5 },
};

test("no move and no time: the estimate is the mark", () => {
  const e = estimateOption({ ...base, spot: 690, now: markAt })!;
  assert.equal(e.model, "black-scholes");
  close(e.price, 2.1);
});

test("a large move stays bounded where a Greeks expansion explodes", () => {
  const now = markAt + 10 * 3600000;
  const e = estimateOption({ ...base, spot: 760, now })!;
  // Intrinsic is 40; the option is worth a little more, not the ~2.1 + 14 +
  // 49 that delta + ½ gamma × move² would give.
  assert.ok(e.price >= 40 && e.price < 42, `${e.price}`);
  const down = estimateOption({ ...base, spot: 600, now })!;
  assert.ok(down.price >= 0 && down.price < 0.01, `${down.price}`);
});

test("time passing decays the value, never below intrinsic", () => {
  const nextDay = estimateOption({
    ...base,
    spot: 690,
    now: markAt + 86400000,
  })!;
  assert.ok(nextDay.timeEffect < 0 && nextDay.price < 2.1);
  close(nextDay.price, 2.1 + nextDay.moveEffect + nextDay.timeEffect);
  // After expiry only intrinsic value remains.
  const expired = estimateOption({
    ...base,
    spot: 730,
    now: Date.parse("2026-10-17T12:00:00Z"),
  })!;
  close(expired.price, 10);
});

test("without any volatility the Greeks expansion is used, capped by time value", () => {
  const e = estimateOption({
    ...base,
    mark: -1, // no usable mark
    spot: 690,
    now: markAt,
  });
  assert.equal(e, null);
  // A mark the model cannot reach and no feed IV: Greeks.
  const greeks = estimateOption({
    ...base,
    strike: 650,
    mark: 30, // below the 40 intrinsic, so no IV solves it
    impliedVolatility: null,
    spot: 695,
    now: markAt + 3 * 86400000,
  })!;
  assert.equal(greeks.model, "greeks");
  // theta × 3 days = −1.5, but the mark holds no time value to lose.
  assert.equal(greeks.timeEffect, 0);
  assert.equal(greeks.price, 45); // floor at intrinsic
});
