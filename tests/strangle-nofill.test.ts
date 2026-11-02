// SYNTHETIC jobs: why a Volume bot buy came back with nothing filled (user 2026-11-02, USO 22:03).
import { test } from "node:test";
import assert from "node:assert/strict";
import { noFillWhy } from "../apps/trader/src/strangle.js";

const done = (result: object) => ({ state: "done", result: { result } });
const quote = { bid: 0.8, ask: 1.1 };

test("no fill: the ladder's refusals and the broker's end, with the book", () => {
  assert.equal(
    noFillWhy(done({ status: "rejected-spread", spreadRatio: 0.316, quote })),
    "spread 32% (bid 0.80, ask 1.10), over the 25% limit: not sent",
  );
  assert.equal(
    noFillWhy(done({ status: "rejected-spread", quote: { bid: 0, ask: 1.1 } })),
    "no bid (bid 0.00, ask 1.10): not sent",
  );
  assert.equal(
    noFillWhy(done({ status: "rejected-budget", quote })),
    "the price ran past the order's cap (bid 0.80, ask 1.10): not sent",
  );
  assert.equal(
    noFillWhy(done({ status: "closed", quote, order: { status: "canceled" } })),
    "the broker ended it: canceled (bid 0.80, ask 1.10)",
  );
});

test("no fill: a failed job says its error", () => {
  assert.equal(
    noFillWhy({ state: "failed", result: { error: "Alpaca 403" } }),
    "the order failed: Alpaca 403",
  );
  assert.equal(
    noFillWhy({ state: "interrupted", result: { notes: [] } }),
    "the order ended interrupted",
  );
});
