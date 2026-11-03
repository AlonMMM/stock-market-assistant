// SYNTHETIC legs and fills: Alpaca against IBKR on the same signals
// (packages/trading/src/bot/compare.ts).
import assert from "node:assert/strict";
import test from "node:test";
import {
  compareLegs,
  type CompareLeg,
  type ComparePosition,
} from "../packages/trading/src/bot/compare.js";

const book = (mid: number) => ({ bid: mid - 0.01, ask: mid + 0.01, mid });
const leg = (
  broker: "alpaca" | "ibkr",
  over: Partial<CompareLeg> = {},
): CompareLeg => ({
  broker,
  outcome: "bought",
  detail: "",
  ...over,
});
const closed = (
  id: string,
  broker: "alpaca" | "ibkr",
  cost: number,
  sold: number,
  over: Partial<ComparePosition> = {},
): ComparePosition => ({
  id,
  broker,
  cost,
  bought: 10,
  status: "closed",
  sales: [{ qty: 10, price: sold }],
  ...over,
});

test("compare: same contract, the fill gap and each leg's result per day and in total", () => {
  const c = "NVDA261023C00110000";
  const at = 1_000_000;
  const out = compareLegs(
    [
      {
        day: "2026-11-03",
        symbol: "NVDA",
        at,
        legs: [
          leg("alpaca", {
            contract: c,
            book: book(0.6),
            pickMs: 400,
            positionId: "a1",
          }),
          leg("ibkr", {
            contract: c,
            book: book(0.66),
            pickMs: 1200,
            positionId: "i1",
          }),
        ],
      },
      // Only one account: not compared.
      { day: "2026-11-03", symbol: "AMD", at, legs: [leg("alpaca")] },
    ],
    [
      closed("a1", "alpaca", 0.6, 0.9, { filledAt: at + 5_000 }),
      closed("i1", "ibkr", 0.63, 0.9, { filledAt: at + 9_000 }),
    ],
  );
  assert.equal(out.days.length, 1);
  const t = out.total;
  assert.deepEqual([t.signals, t.same, t.different], [1, 1, 0]);
  assert.equal(t.fillGapPct, 5); // 0.63 against 0.60
  assert.equal(t.quoteGapPct, 10); // 0.66 against 0.60
  assert.deepEqual(
    [t.alpaca.taken, t.alpaca.pickMs, t.alpaca.fillMs, t.alpaca.pnlUsd],
    [1, 400, 5000, 300],
  );
  assert.equal(t.alpaca.pnlPct, 50);
  assert.equal(t.ibkr.pnlUsd, 270);
  assert.equal(t.ibkr.fillMs, 9000);
  assert.deepEqual(out.oneSided, []);
});

test("compare: different contracts use the cross quotes; an add counts in its leg's result; one-sided misses are listed", () => {
  const at = 5_000;
  const out = compareLegs(
    [
      {
        day: "2026-11-02",
        symbol: "MU",
        at,
        legs: [
          leg("alpaca", {
            contract: "A",
            book: book(1),
            positionId: "a1",
            cross: { contract: "B", book: { bid: 0.79, ask: 0.81 } },
          }),
          leg("ibkr", {
            contract: "B",
            book: book(0.84),
            positionId: "i1",
          }),
        ],
      },
      {
        day: "2026-11-03",
        symbol: "WMT",
        at,
        legs: [
          leg("alpaca", { outcome: "thin", detail: "34 contracts" }),
          leg("ibkr", { contract: "W", positionId: "i2" }),
        ],
      },
    ],
    [
      closed("a1", "alpaca", 1, 2),
      closed("a2", "alpaca", 1, 0, {
        addOf: "a1",
        bought: 5,
        sales: [{ qty: 5, price: 0 }],
      }),
      closed("i1", "ibkr", 0.84, 1),
      { ...closed("i2", "ibkr", 1, 1), status: "open", sales: [] },
    ],
  );
  assert.deepEqual(
    out.days.map((d) => d.day),
    ["2026-11-03", "2026-11-02"],
  );
  assert.equal(out.total.different, 1);
  assert.equal(out.total.quoteGapPct, 5); // IBKR 0.84 against Alpaca's 0.80 for B
  assert.equal(out.total.fillGapPct, null); // different contracts
  // The add bought 5 at 1 and sold at 0: -500 against the first leg's +1,000.
  assert.equal(out.total.alpaca.pnlUsd, 500);
  assert.equal(out.total.ibkr.open, 1);
  assert.deepEqual(out.oneSided, [
    {
      day: "2026-11-03",
      symbol: "WMT",
      took: "ibkr",
      missed: "alpaca",
      outcome: "thin",
      detail: "34 contracts",
    },
  ]);
});
