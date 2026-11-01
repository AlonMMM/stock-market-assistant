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

test("alert books: every 2 s for 300 s, then once a minute until the last sale; batched reads", async () => {
  let now = Date.parse("2026-10-29T14:00:00Z");
  const endAt = now + 20 * 60_000;
  let bid = 1;
  const s = store();
  const reads: string[][] = [];
  const books = new AlertBooks({
    store: s,
    now: () => now,
    async chain(_u, right) {
      return right === "call"
        ? [q("call", 205, 0.3, bid), q("call", 220, 0.02, 0.01)]
        : [q("put", 195, -0.25, bid / 2)];
    },
    async quotes(contracts) {
      reads.push(contracts);
      return contracts.map((c) =>
        c.includes("C")
          ? { ...q("call", 205, 0.3, bid), symbol: c }
          : { ...q("put", 195, -0.25, bid / 2), symbol: c },
      );
    },
  });
  const alert = {
    day: DAY,
    symbol: "NVDA",
    second: 3000,
    kind: "fast" as const,
    expiry: EXP,
    endAt,
  };
  await books.start(alert);
  assert.equal(books.active, 1);
  // 300 s at 2 s: 150 reads, each one request for both contracts.
  for (let i = 0; i < 150; i++) {
    now += bookWatch.everyMs;
    bid += 0.01;
    await books.step();
  }
  // 149 at 2 s, and at 300 s the first minute read (a new minute).
  assert.equal(reads.length, 150);
  assert.deepEqual(reads[0], ["NVDA261029C00205000", "NVDA261029P00195000"]);
  let [saved] = s.alertBooks(DAY);
  assert.ok(saved!.samples.length >= 140);
  const last = saved!.samples.at(-1)!;
  assert.deepEqual(last.books[0], [bid, bid + 0.05]);
  // Then once a minute: 2-second steps in the same minute do not read.
  const before = reads.length;
  for (let i = 0; i < 60; i++) {
    now += bookWatch.everyMs;
    await books.step();
  }
  assert.ok(
    reads.length - before <= 3,
    `${reads.length - before} reads in 2 minutes`,
  );
  // Past the last sale: the last write, then the watch ends.
  now = endAt;
  await books.step();
  assert.equal(books.active, 0);
  [saved] = s.alertBooks(DAY);
  const minuteReads = saved!.samples.filter(
    (x) => x.at - saved!.startedAt >= bookWatch.fineMs,
  ).length;
  assert.ok(minuteReads >= 2 && minuteReads <= 4);
  // The same alert again does not start a second watch's row.
  await books.start(alert);
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
  const at = {
    day: DAY,
    second: 10,
    kind: "shock" as const,
    expiry: EXP,
    endAt: 3_600_000,
  };
  await none.start({ ...at, symbol: "AMD" });
  assert.equal(none.active, 0);
  await books.start({ ...at, symbol: "NVDA" });
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
