import { test } from "node:test";
import assert from "node:assert/strict";
import { bookOf, lastBookOf } from "../apps/trader/src/option-book.js";

test("the book at a buy's last raise, from its job's result", () => {
  // User 2026-10-27: a chased buy filled at 0.60 looked "over the ask"
  // against the book when it was sent; the last raise's book is kept too.
  const job = { result: { status: "filled", quote: { bid: 0.58, ask: 0.6 } } };
  assert.deepEqual(lastBookOf(job, 5, "alpaca"), {
    bid: 0.58,
    ask: 0.6,
    at: 5,
    broker: "alpaca",
  });
  // The broker's own quote time wins when it has one.
  const timed = { result: { quote: { bid: 1, ask: 1.1, quotedAt: 3 } } };
  assert.equal(lastBookOf(timed, 5, "ibkr")?.at, 3);
  // Refused buys and other results have no quote.
  assert.equal(lastBookOf({ refused: ["x"] }, 5, "alpaca"), undefined);
  assert.equal(lastBookOf(null, 5, "alpaca"), undefined);
  assert.equal(bookOf(null, 5, "alpaca"), undefined);
});
