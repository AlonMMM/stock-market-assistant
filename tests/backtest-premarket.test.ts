// The pre-market columns of the Backtest pages (the user, 2026-11-06: "a column
// that describe how much the pre-market was busy ... and how much the spy").
import { test } from "node:test";
import assert from "node:assert/strict";
import { premarketX } from "../packages/trading/src/bot/backtest.js";
import { backtestCalendar } from "../packages/market-data/src/bot-backtest.js";

const date = "2026-10-06";
const before = backtestCalendar.previousSessions(date, 20);

test("pre-market ratio: today's volume over the median of the 20 sessions before", () => {
  const volume = new Map(before.map((d, i) => [d, i % 2 ? 1000 : 3000]));
  volume.set(date, 10000);
  const data = { premarket: (_s: string, d: string) => volume.get(d) ?? null };
  // The median of ten 1,000s and ten 3,000s is 2,000: 10,000 is 5×.
  assert.equal(premarketX("AAPL", date, data, backtestCalendar), 5);
});

test("pre-market ratio: null without today's volume or with under 10 prior sessions", () => {
  const few = new Map(before.slice(-9).map((d) => [d, 1000]));
  few.set(date, 5000);
  assert.equal(
    premarketX(
      "AAPL",
      date,
      { premarket: (_s, d) => few.get(d) ?? null },
      backtestCalendar,
    ),
    null,
  );
  assert.equal(
    premarketX("AAPL", date, { premarket: () => null }, backtestCalendar),
    null,
  );
});
