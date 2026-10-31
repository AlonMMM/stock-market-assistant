// SYNTHETIC chains and bars: the Volume bot's saved alert data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AlertBooks,
  bookWatch,
  watchedContracts,
} from "../apps/trader/src/alert-books.js";
import { StrangleStore } from "../apps/trader/src/strangle-store.js";
import type { OptionQuote } from "../packages/trading/src/options.js";

const DAY = "2026-10-29";
const EXP = "2026-10-29";
const store = () =>
  new StrangleStore(join(mkdtempSync(join(tmpdir(), "books-")), "t.sqlite"));

const q = (
  right: "call" | "put",
  strike: number,
  delta: number | null,
  bid: number,
): OptionQuote => ({
  symbol: `NVDA261029${right === "call" ? "C" : "P"}00${strike}000`,
  underlying: "NVDA",
  expiry: EXP,
  right,
  strike,
  bid,
  ask: bid + 0.05,
  delta,
});

test("alert books: only |delta| 0.10-0.35, calls and puts", () => {
  const got = watchedContracts([
    q("call", 200, 0.5, 3),
    q("call", 205, 0.35, 1.5),
    q("call", 210, 0.1, 0.4),
    q("call", 215, 0.05, 0.1),
    q("put", 195, -0.2, 1),
    q("put", 190, -0.09, 0.2),
    q("put", 185, null, 0.1),
  ]).map((c) => c.symbol);
  assert.deepEqual(got, [
    "NVDA261029C00205000",
    "NVDA261029C00210000",
    "NVDA261029P00195000",
  ]);
});

test("alert books: a sample every step for 30 minutes, saved while it runs and at the end", async () => {
  let now = Date.parse("2026-10-29T14:00:00Z");
  let bid = 1;
  const s = store();
  const books = new AlertBooks({
    store: s,
    now: () => now,
    async chain(_u, right) {
      return right === "call"
        ? [q("call", 205, 0.3, bid), q("call", 220, 0.02, 0.01)]
        : [q("put", 195, -0.25, bid / 2)];
    },
  });
  await books.start({
    day: DAY,
    symbol: "NVDA",
    second: 3000,
    kind: "fast",
    expiry: EXP,
  });
  assert.equal(books.active, 1);
  for (let i = 0; i < 10; i++) {
    now += bookWatch.everyMs;
    bid += 0.1;
    await books.step();
  }
  // Saved every 30 s while it runs: 20 s in, only the first write.
  let [saved] = s.alertBooks(DAY);
  assert.equal(saved!.samples.length, 1);
  now += 15_000;
  await books.step();
  [saved] = s.alertBooks(DAY);
  assert.equal(saved!.samples.length, 12);
  assert.deepEqual(
    saved!.contracts.map((c) => c.symbol),
    ["NVDA261029C00205000", "NVDA261029P00195000"],
  );
  const last = saved!.samples.at(-1)!;
  assert.deepEqual(last.books[0], [bid, bid + 0.05]);
  assert.deepEqual(last.books[1], [bid / 2, bid / 2 + 0.05]);
  // Past 30 minutes: the last write, then the watch ends.
  now += bookWatch.forMs;
  await books.step();
  assert.equal(books.active, 0);
  [saved] = s.alertBooks(DAY);
  assert.equal(saved!.samples.length, 12);
  // The same alert again does not start a second watch.
  await books.start({
    day: DAY,
    symbol: "NVDA",
    second: 3000,
    kind: "fast",
    expiry: EXP,
  });
  assert.equal(s.alertBooks(DAY).length, 1);
});

test("alert books: no contract in range, no watch; a failed read is a gap", async () => {
  let fail = false;
  const s = store();
  let now = 0;
  const books = new AlertBooks({
    store: s,
    now: () => now,
    async chain(_u, right) {
      if (fail) throw new Error("down");
      return right === "call" ? [q("call", 205, 0.3, 1)] : [];
    },
  });
  const none = new AlertBooks({
    store: s,
    now: () => now,
    chain: async () => [q("call", 200, 0.6, 3)],
  });
  await none.start({
    day: DAY,
    symbol: "AMD",
    second: 10,
    kind: "shock",
    expiry: EXP,
  });
  assert.equal(none.active, 0);
  await books.start({
    day: DAY,
    symbol: "NVDA",
    second: 10,
    kind: "shock",
    expiry: EXP,
  });
  fail = true;
  now += 40_000;
  await books.step();
  const [saved] = s.alertBooks(DAY);
  assert.equal(saved!.kind, "shock");
  assert.deepEqual(saved!.samples.at(-1)!.books, [null]);
});

test("the 10-second bars and the windows are kept for good", () => {
  const s = store();
  s.saveFastBars("NVDA", DAY, { v: [0, 500, 20], c: [null, 201.5, 201.6] });
  assert.deepEqual(s.fastBars("NVDA", DAY), {
    v: [0, 500, 20],
    c: [null, 201.5, 201.6],
  });
  assert.deepEqual(s.fastBarSymbols(DAY), ["NVDA"]);
  // 35 sessions: the oldest is still there (it was 30 a stock before).
  for (let i = 0; i < 35; i++)
    s.saveFastDay(
      "NVDA",
      new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10),
      { vol: [i + 1], move: [null] },
    );
  assert.deepEqual(s.fastDay("NVDA", "2026-08-01"), { vol: [1], move: [null] });
});
