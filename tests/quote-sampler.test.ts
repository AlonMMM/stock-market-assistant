import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newYorkToUtc } from "../packages/market-data/src/calendar.js";
import type { OptionQuote } from "../packages/trading/src/options.js";
import { defaultPickRules } from "../packages/trading/src/bot/picker.js";
import { dueAt, sampleSide } from "../packages/trading/src/bot/quote-sample.js";
import { BotStore } from "../apps/trader/src/bot-store.js";
import { QuoteSampler } from "../apps/trader/src/quote-sampler.js";

// Synthetic chains: NVDA at 100, Friday expiry, strikes every 5.
const DAY = "2026-10-21";
const quote = (
  right: "call" | "put",
  strike: number,
  delta: number,
  bid: number,
): OptionQuote => ({
  symbol: `NVDA261023${right === "call" ? "C" : "P"}${String(strike * 1000).padStart(8, "0")}`,
  underlying: "NVDA",
  expiry: "2026-10-23",
  right,
  strike,
  bid,
  ask: bid + 0.04,
  delta: right === "call" ? delta : -delta,
  openInterest: strike * 3,
});
const calls = [
  quote("call", 100, 0.5, 2),
  quote("call", 105, 0.25, 0.6),
  quote("call", 110, 0.15, 0.1), // the pick, under the bot's $0.20: sampled anyway
  quote("call", 115, 0.07, 0.05),
];
const puts = [
  quote("put", 85, 0.06, 0.05),
  quote("put", 90, 0.14, 0.3), // the pick
  quote("put", 95, 0.3, 0.9),
  quote("put", 100, 0.5, 2),
];

test("quote sample: the bot's pick at any price, and the next strike in and out", () => {
  const rules = { ...defaultPickRules, cheapFallback: true };
  assert.deepEqual(
    sampleSide(calls, 100, "call", DAY, rules).map((x) => [
      x.slot,
      x.quote.strike,
    ]),
    [
      ["pick", 110],
      ["in", 105],
      ["out", 115],
    ],
  );
  assert.deepEqual(
    sampleSide(puts, 100, "put", DAY, rules).map((x) => [
      x.slot,
      x.quote.strike,
    ]),
    [
      ["pick", 90],
      ["in", 95],
      ["out", 85],
    ],
  );
  assert.deepEqual(sampleSide([], 100, "call", DAY, rules), []);
});

test("quote sample: each stock every 15 minutes, spread over the minutes", () => {
  const symbols = Array.from({ length: 31 }, (_, i) => `S${i}`);
  assert.deepEqual(dueAt(symbols, 10, 15), ["S10", "S25"]);
  assert.deepEqual(dueAt(symbols, 25, 15), ["S10", "S25"]);
  const seen = new Set<string>();
  for (let m = 10; m < 25; m++)
    for (const s of dueAt(symbols, m, 15)) seen.add(s);
  assert.equal(seen.size, 31);
});

test("quote sampler: stores the books with volume and open interest, once a minute, in session only", async () => {
  const store = new BotStore(
    join(mkdtempSync(join(tmpdir(), "qs-")), "t.sqlite"),
  );
  let now = newYorkToUtc(DAY, 570 + 10) + 5000; // 09:40:05
  let chainCalls = 0;
  const sampler = new QuoteSampler({
    store,
    chain: async (_u, right) => {
      chainCalls++;
      return right === "call" ? calls : puts;
    },
    volumes30: async (contracts) =>
      new Map(contracts.map((c, i) => [c, i * 100])),
    // NVDA is due at minute 10 (index 10 of 15); the others are not.
    symbols: () => [...Array.from({ length: 10 }, (_, i) => `X${i}`), "NVDA"],
    spot: (s) => (s === "NVDA" ? 100 : null),
    rules: () => defaultPickRules,
    now: () => now,
  });
  await sampler.tick();
  await sampler.tick(); // the same minute: nothing new
  const rows = store.quoteSamples(DAY);
  assert.equal(chainCalls, 2);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[0], {
    day: DAY,
    minute: 10,
    at: now,
    symbol: "NVDA",
    spot: 100,
    right: "C",
    slot: "pick",
    contract: "NVDA261023C00110000",
    expiry: "2026-10-23",
    strike: 110,
    delta: 0.15,
    bid: 0.1,
    ask: 0.14,
    volume30: 0,
    openInterest: 330,
  });
  assert.equal(rows[3]!.right, "P");
  assert.equal(rows[5]!.volume30, 500);
  // Before 09:40 and on a weekend: no samples.
  now = newYorkToUtc(DAY, 570 + 5);
  await sampler.tick();
  now = newYorkToUtc("2026-10-24", 570 + 25);
  await sampler.tick();
  assert.equal(chainCalls, 2);
});
