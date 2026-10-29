import assert from "node:assert/strict";
import test from "node:test";
import {
  alertBars,
  barsUrl,
  chartTime,
  legendLine,
  mergeRows,
  ordinal,
  rangeText,
  sessionStarts,
  signedChange,
  volumeChip,
  vwapLine,
  type ChartBarsRow,
} from "../apps/web/src/fullscreen-model.js";

// Synthetic rows: 5-minute bars from 09:30 New York (13:30 UTC in October).
const row = (start: string, date = start.slice(0, 10)): ChartBarsRow => ({
  start: Date.parse(start) / 1000,
  date,
  stock: { open: 1, high: 1, low: 1, close: 1, volume: 1 },
  against: null,
  previousClose: null,
  againstPreviousClose: null,
  vwap: null,
  averageVolume: null,
  volumePercentile: null,
});

test("full screen: what each bar size shows when it opens", () => {
  assert.equal(rangeText("1m"), "yesterday and today");
  assert.equal(rangeText("5m"), "last 5 sessions");
  assert.equal(rangeText("1h"), "last 30 sessions");
  assert.equal(rangeText("1D"), "last 12 months");
});

test("full screen: the bars request names the benchmark and, for a past day, its end", () => {
  assert.equal(
    barsUrl("NVDA", "SMH", "15m"),
    "/api/bars?ticker=NVDA&against=SMH&bar=15m&extended=1",
  );
  assert.equal(
    barsUrl("NVDA", "SPY", "1m", "2026-10-14"),
    "/api/bars?ticker=NVDA&against=SPY&bar=1m&extended=1&end=2026-10-14",
  );
  // Daily bars are regular-hours bars.
  assert.equal(
    barsUrl("NVDA", "SPY", "1D"),
    "/api/bars?ticker=NVDA&against=SPY&bar=1D",
  );
});

test("full screen: a later read replaces the same bars and adds new ones in time order", () => {
  const a = row("2026-10-16T13:30:00Z");
  const b = row("2026-10-16T13:35:00Z");
  const b2 = { ...b, stock: { ...b.stock, close: 2 } };
  const c = row("2026-10-16T13:40:00Z");
  const older = row("2026-10-15T19:55:00Z");
  const merged = mergeRows([a, b], [b2, c]);
  assert.deepEqual(
    merged.map((r) => r.stock.close),
    [1, 2, 1],
  );
  assert.equal(mergeRows([older], merged)[0], older);
});

test("full screen: intraday bars read on the Israel clock, daily bars on their date", () => {
  const r = row("2026-10-16T13:30:00Z");
  assert.equal(chartTime(r, "5m"), Date.parse("2026-10-16T16:30:00Z") / 1000);
  assert.equal(chartTime(r, "1D"), Date.parse("2026-10-16T00:00:00Z") / 1000);
});

test("full screen: dashed lines where a session starts, or a month on 1D", () => {
  const rows = [
    row("2026-10-15T19:50:00Z"),
    row("2026-10-15T19:55:00Z"),
    row("2026-10-16T13:30:00Z"),
  ];
  assert.deepEqual(sessionStarts(rows, "5m"), [2]);
  const days = ["2026-09-29", "2026-09-30", "2026-10-01"].map((d) =>
    row(`${d}T04:00:00Z`),
  );
  assert.deepEqual(sessionStarts(days, "1D"), [2]);
});

test("full screen: the alert band covers the bars in its window, on 1m and 5m only", () => {
  const rows = [0, 5, 10, 15, 20].map((m) =>
    row(new Date(Date.parse("2026-10-16T14:00:00Z") + m * 60000).toISOString()),
  );
  // A 15-minute window ending 14:22 runs from 14:07: bars 14:05–14:20.
  assert.deepEqual(
    alertBars(rows, "5m", "2026-10-16T14:22:00Z", 15),
    [1, 2, 3, 4],
  );
  assert.deepEqual(alertBars(rows, "15m", "2026-10-16T14:22:00Z", 15), []);
  assert.deepEqual(alertBars(rows, "5m", undefined, 15), []);
});

test("full screen: today's volume chip with the average and percentile", () => {
  const label = () => "18:00";
  assert.deepEqual(
    volumeChip(
      {
        date: "2026-10-16",
        through: 0,
        volume: 38_400_000,
        averageVolume: 24_000_000,
        percentile: 85,
        sessions: 20,
      },
      label,
    ),
    {
      text: "Vol 38.4M · 1.6× avg · 85th pct",
      title:
        "Volume by 18:00 against the average by the same time over the last 20 sessions; higher than 17 of them",
    },
  );
  assert.equal(
    volumeChip(
      {
        date: "2026-10-16",
        through: 0,
        volume: 3_100_000,
        averageVolume: null,
        percentile: null,
        sessions: 12,
      },
      label,
    )?.text,
    "Vol 3.1M · — avg",
  );
  assert.equal(volumeChip(null, label), null);
});

test("full screen: legend lines, changes and ordinals", () => {
  assert.equal(
    legendLine("NVDA", "5m", {
      open: 131.2,
      high: 131.62,
      low: 130.98,
      close: 131.4,
      volume: 1,
    }),
    "NVDA · 5m · O 131.20  H 131.62  L 130.98  C 131.40",
  );
  assert.equal(
    vwapLine("NVDA", 131.62, 131.2),
    "VWAP 131.20 · NVDA above by 0.32%",
  );
  assert.equal(
    vwapLine("NVDA", 130, 131.2),
    "VWAP 131.20 · NVDA below by 0.91%",
  );
  assert.equal(signedChange(102, 100), "+2.00%");
  assert.equal(signedChange(99, 100), "−1.00%");
  assert.equal(signedChange(99, null), null);
  assert.deepEqual([1, 2, 3, 11, 12, 13, 21, 85, 100].map(ordinal), [
    "1st",
    "2nd",
    "3rd",
    "11th",
    "12th",
    "13th",
    "21st",
    "85th",
    "100th",
  ]);
});
