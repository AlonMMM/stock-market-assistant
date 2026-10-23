import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TradeBarBuilder,
  rollUp,
  tradeRole,
  type Trade,
} from "../packages/market-data/src/trade-bars.js";

const open = Date.parse("2026-10-07T13:30:00Z"); // 09:30 New York (EDT)
const close = Date.parse("2026-10-07T20:00:00Z");
const trade = (
  offsetMs: number,
  price: number,
  size: number,
  conditions: string[] = ["@"],
  tape = "C",
  correction?: string,
): Trade => ({
  time: open + offsetMs,
  price,
  size,
  conditions,
  tape,
  ...(correction ? { correction } : {}),
});

test("tradeRole follows Alpaca's intraday condition rules per tape", () => {
  assert.deepEqual(tradeRole({ conditions: ["@"], tape: "C" }), {
    price: true,
    volume: true,
  });
  // Odd lots count for volume only, on both tapes.
  assert.deepEqual(tradeRole({ conditions: ["@", "I"], tape: "A" }), {
    price: false,
    volume: true,
  });
  // Official open/close prints and corrected closes count for nothing.
  for (const code of ["M", "Q", "9"])
    assert.deepEqual(tradeRole({ conditions: [code], tape: "B" }), {
      price: false,
      volume: false,
    });
  // Form T is excluded only from daily bars.
  assert.deepEqual(tradeRole({ conditions: ["@", "T"], tape: "C" }), {
    price: true,
    volume: true,
  });
  // Average price: B on CTA, W on UTP; the other tape's code is just a code.
  assert.equal(tradeRole({ conditions: ["B"], tape: "A" }).price, false);
  assert.equal(tradeRole({ conditions: ["W"], tape: "A" }).price, true);
  assert.equal(tradeRole({ conditions: ["W"], tape: "C" }).price, false);
  assert.equal(tradeRole({ conditions: ["B"], tape: "C" }).price, true);
  // An unknown tape gets both lists.
  assert.equal(tradeRole({ conditions: ["W"], tape: "N" }).price, false);
  assert.equal(tradeRole({ conditions: ["B"], tape: "N" }).price, false);
  // Canceled or superseded prints never count; the correction itself does.
  assert.deepEqual(
    tradeRole({ conditions: ["@"], tape: "C", correction: "canceled" }),
    { price: false, volume: false },
  );
  assert.deepEqual(
    tradeRole({ conditions: ["@"], tape: "C", correction: "incorrect" }),
    { price: false, volume: false },
  );
  assert.equal(
    tradeRole({ conditions: ["@"], tape: "C", correction: "corrected" }).price,
    true,
  );
});

test("10-second bars: alignment, OHLC order, volume, vwap and trade count", () => {
  const builder = new TradeBarBuilder(10, open, close);
  // Bucket 09:30:00–09:30:10, fed out of order.
  builder.add(trade(7_500, 101, 100));
  builder.add(trade(200, 100, 100));
  builder.add(trade(4_000, 103, 50));
  builder.add(trade(9_999, 99, 100));
  // Odd lot: volume and vwap only.
  builder.add(trade(5_000, 150, 7, ["@", "I"]));
  // Next bucket starts exactly at :10.
  builder.add(trade(10_000, 102, 10));
  const bars = builder.bars();
  assert.equal(bars.length, 2);
  const [first, second] = bars;
  assert.equal(first!.start, open / 1000);
  assert.equal(first!.open, 100);
  assert.equal(first!.high, 103);
  assert.equal(first!.low, 99);
  assert.equal(first!.close, 99);
  assert.equal(first!.volume, 357);
  assert.equal(first!.trades, 5);
  assert.ok(
    Math.abs(
      first!.vwap -
        (100 * 100 + 101 * 100 + 103 * 50 + 99 * 100 + 150 * 7) / 357,
    ) < 1e-9,
  );
  assert.equal(second!.start, open / 1000 + 10);
  assert.equal(second!.volume, 10);
  assert.equal(second!.trades, 1);
});

test("10-second bars: window trimming and bars without prices are dropped", () => {
  const builder = new TradeBarBuilder(10, open, close);
  builder.add(trade(-1, 50, 100)); // pre-market, just before the open
  builder.add(trade(close - open, 50, 100)); // 16:00:00.000 is after the window
  builder.add(trade(20_000, 50, 5, ["@", "I"])); // lone odd lot: no bar
  builder.add(trade(30_000, 50, 100, ["M"])); // official close print: nothing
  builder.add(trade(40_000, 0, 100)); // bad price
  builder.add(trade(40_000, 50, 0)); // bad size
  builder.add(trade(50_000, 51, 100));
  const bars = builder.bars();
  assert.deepEqual(
    bars.map((b) => b.start - open / 1000),
    [50],
  );
  assert.throws(() => new TradeBarBuilder(0, open, close));
});

test("rollUp rebuilds a minute from its 10-second bars", () => {
  const builder = new TradeBarBuilder(10, open, close);
  builder.add(trade(1_000, 10, 100));
  builder.add(trade(15_000, 12, 100));
  builder.add(trade(35_000, 9, 200));
  builder.add(trade(59_000, 11, 100));
  builder.add(trade(61_000, 20, 100));
  const minutes = rollUp(builder.bars(), 60);
  assert.equal(minutes.length, 2);
  assert.deepEqual(
    { ...minutes[0], vwap: Math.round(minutes[0]!.vwap * 1000) / 1000 },
    {
      start: open / 1000,
      open: 10,
      high: 12,
      low: 9,
      close: 11,
      volume: 500,
      trades: 4,
      vwap: Math.round(((10 + 12 + 9 * 2 + 11) * 100 * 1000) / 500) / 1000,
    },
  );
  assert.equal(minutes[1]!.open, 20);
});
