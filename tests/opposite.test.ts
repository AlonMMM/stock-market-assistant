import { test } from "node:test";
import assert from "node:assert/strict";
import {
  opposite,
  oppositeDefaults,
} from "../packages/market-data/src/opposite.js";
import type {
  ChartBar,
  ChartSeries,
} from "../packages/market-data/src/day-chart.js";

// SYNTHETIC data: Tue 2026-06-02 (EDT), regular open 13:30 UTC, previous close 100.
const open = Date.parse("2026-06-02T13:30:00Z") / 1000;

// `percents[k]` is the % from previous close at regular minute k (null = no bar).
function series(
  ticker: string,
  percents: (number | null)[],
  pre: number[] = [],
): ChartSeries {
  const bars: ChartBar[] = [];
  pre.forEach((p, k) =>
    bars.push({
      start: open - (pre.length - k) * 60,
      session: "pre",
      open: 100 * (1 + p / 100),
      close: 100 * (1 + p / 100),
      volume: 1000,
    }),
  );
  percents.forEach((p, k) => {
    if (p === null) return;
    bars.push({
      start: open + k * 60,
      session: "regular",
      open: 100 * (1 + p / 100),
      close: 100 * (1 + p / 100),
      volume: 1000,
    });
  });
  return { ticker, previousClose: 100, bars };
}
const flat = (n: number) => Array.from({ length: n }, () => 0);

test("defaults are one named options object", () => {
  assert.deepEqual(
    { ...oppositeDefaults },
    {
      window: 5,
      benchFall: -0.05,
      benchHold: -0.02,
      weakMultiple: 2,
      minUsualMoves: 15,
    },
  );
});

test("scenario 12: benchmark −0.06 or exactly −0.05 with ticker up is strong; −0.04 is none", () => {
  for (const [fall, expected] of [
    [-0.06, "strong"],
    [-0.05, "strong"],
    [-0.04, null],
  ] as const) {
    const bench = series("SPY", [...flat(5), fall]);
    const tick = series("AAPL", [...flat(5), 0.02]);
    const result = opposite(tick, bench);
    assert.deepEqual(result.states, [...flat(5).map(() => null), expected]);
    assert.deepEqual(
      result.episodes,
      expected ? [{ kind: "strong", from: 0, to: 5 }] : [],
    );
  }
});

test("a ticker falling while the benchmark falls is not strong", () => {
  const result = opposite(
    series("AAPL", [...flat(5), -0.01]),
    series("SPY", [...flat(5), -0.1]),
  );
  assert.deepEqual(result.states.at(-1), null);
});

// Ticker moves exactly 0.1 pts every 5-minute window (alternating levels), so
// `usual` is 0.1; at minute 30 it falls `drop` × usual while SPY rises 0.01.
function weakDay(drop: number) {
  const ticker: number[] = Array.from({ length: 31 }, (_, k) =>
    Math.floor(k / 5) % 2 ? 0.1 : 0,
  );
  ticker[30] = ticker[25]! - drop * 0.1;
  const bench = Array.from({ length: 31 }, (_, k) => 0.002 * k);
  return opposite(series("AAPL", ticker), series("SPY", bench));
}

test("scenario 12: SPY +0.01 while ticker falls 2.1× usual is weak; 1.9× is none", () => {
  const weak = weakDay(2.1);
  assert.equal(weak.states[30], "weak");
  assert.equal(weak.states.filter(Boolean).length, 1);
  assert.deepEqual(weak.episodes, [{ kind: "weak", from: 25, to: 30 }]);
  const none = weakDay(1.9);
  assert.deepEqual(none.states.filter(Boolean), []);
  assert.deepEqual(none.episodes, []);
});

test("no weak state until 15 moves exist", () => {
  // Minute 18 has only 14 moves (minutes 5..18): a big fall stays unmarked.
  const ticker: number[] = Array.from({ length: 19 }, (_, k) =>
    Math.floor(k / 5) % 2 ? 0.1 : 0,
  );
  ticker[18] = ticker[13]! - 1;
  const result = opposite(series("AAPL", ticker), series("SPY", flat(19)));
  assert.deepEqual(result.states.filter(Boolean), []);
  // One more minute and the same fall is weak.
  ticker.push(ticker[14]! - 1);
  const later = opposite(series("AAPL", ticker), series("SPY", flat(20)));
  assert.equal(later.states[19], "weak");
});

test("scenario 13: pre-market and the first five regular minutes have no state", () => {
  const pre = Array.from({ length: 30 }, (_, k) => (k % 2 ? 1 : -1));
  const benchPre = Array.from({ length: 30 }, (_, k) => -0.2 * k);
  const tick = series("AAPL", [0.5, 0.5, 0.5, 0.5, 0.5], pre);
  const bench = series("SPY", [-1, -1, -1, -1, -1], benchPre);
  const result = opposite(tick, bench);
  assert.equal(result.states.length, 35);
  assert.deepEqual(result.states.filter(Boolean), []);
  assert.deepEqual(result.episodes, []);
});

test("bars align by timestamp when the benchmark misses minutes", () => {
  // SPY has no bars at minutes 1–3; index alignment would compare wrong minutes.
  const bench = series("SPY", [0, null, null, null, 0, -0.06, -0.06]);
  const tick = series("AAPL", [0, 0, 0, 0, 0, 0.02, 0.02], [0.3, 0.3]);
  const result = opposite(tick, bench);
  // Ticker indices are offset by its two pre-market bars.
  assert.deepEqual(result.states, [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    "strong",
    "strong",
  ]);
  assert.deepEqual(result.episodes, [{ kind: "strong", from: 2, to: 8 }]);
});

test("missing previous close yields no states", () => {
  const tick = { ...series("AAPL", [...flat(5), 0.02]), previousClose: null };
  const result = opposite(tick, series("SPY", [...flat(5), -0.1]));
  assert.deepEqual(result.states.filter(Boolean), []);
});
