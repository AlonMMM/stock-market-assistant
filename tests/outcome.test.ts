import { test } from "node:test";
import assert from "node:assert/strict";
import type { PriceBar } from "../packages/market-data/src/bars.js";
import { previousSessions } from "../packages/market-data/src/calendar.js";
import {
  OutcomeScorer,
  parseValidation,
  summarize,
} from "../packages/market-data/src/outcome.js";

const day = "2026-06-03";
// New York end-minute → bar (EDT: minute 571 ends 13:31Z).
function bar(
  date: string,
  minute: number,
  open: number,
  close: number,
): PriceBar {
  return {
    ticker: "NVDA",
    date,
    minute,
    end: new Date(
      Date.parse(`${date}T04:00:00Z`) + minute * 60000,
    ).toISOString(),
    session: minute <= 570 ? "pre" : minute <= 960 ? "regular" : "post",
    volume: 1000,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    regularClose: 960,
  };
}
// 20 history sessions where the 15 minutes after the signal minute move
// 0.5%, so one unit u = 0.5% for an entry right after the signal. `path(k)` is
// the close k minutes after the signal bar on the alert day.
function scorer(
  path: (k: number) => number,
  signalMinute = 700,
  first = 690,
  last = 780,
) {
  const bars: PriceBar[] = [];
  for (const d of previousSessions(day, 20))
    for (let m = first; m <= last; m++) {
      const c = m >= signalMinute + 15 ? 100.5 : 100;
      bars.push(bar(d, m, c, c));
    }
  let prev = 100;
  for (let m = first; m <= last; m++) {
    const close = m <= signalMinute ? 100 : path(m - signalMinute);
    bars.push(bar(day, m, prev, close));
    prev = close;
  }
  return new OutcomeScorer(bars, parseValidation({}));
}
const signal = bar(day, 700, 100, 100).end;

test("good momentum: 2u in favour before 1u against, small dips allowed", () => {
  // Dips −0.3% (0.6u) at minute 2, then climbs to +1.0% (2u) at minute 6.
  const path = (k: number) =>
    [100, 99.8, 99.7, 99.9, 100.4, 100.8, 101][k] ?? 101;
  const o = scorer(path).score(signal, "up");
  assert.equal(o.result, "good");
  assert.equal(o.entry, 100);
  assert.ok(Math.abs(o.unit! - 0.5) < 1e-9);
  assert.equal(o.minutes, 6);
  assert.ok(Math.abs(o.pullback! + 0.3) < 1e-9);
  assert.ok(Math.abs(o.runUnits! - 2) < 1e-9);
  assert.equal(o.entryAt, "2026-06-03T15:40:00.000Z");
});

test("stopped: a close 1u against the alert marks the entry bad", () => {
  const path = (k: number) => [100, 100.3, 99.9, 99.5, 102][k] ?? 102;
  const o = scorer(path).score(signal, "up");
  assert.equal(o.result, "stopped");
  assert.equal(o.minutes, 3);
  assert.ok(Math.abs(o.run! - 0.3) < 1e-9, "best run before the stop");
});

test("weak: neither barrier within the horizon; forward moves are direction-adjusted", () => {
  const o = scorer((k) => 100 + Math.min(k, 10) * 0.04).score(signal, "up");
  assert.equal(o.result, "weak");
  assert.equal(o.minutes, null);
  assert.ok(Math.abs(o.forward[5]! - 0.2) < 1e-9);
  assert.ok(Math.abs(o.forward[15]! - 0.4) < 1e-9);
  const down = scorer((k) => 100 - Math.min(k, 10) * 0.1).score(signal, "down");
  assert.equal(down.result, "good");
  assert.ok(
    down.forward[5]! > 0,
    "a falling price is in favour of a down alert",
  );
});

test("scoring stops at the regular close and never scores outside regular hours", () => {
  // Signal at 15:55 (minute 955): only five regular minutes remain, rising
  // 0.01 a minute; later post-market bars must not count.
  const late = scorer((k) => 100 + k * 0.01, 955, 940, 1000);
  const o = late.score(bar(day, 955, 100, 100).end, "up");
  assert.equal(o.result, "weak");
  assert.ok(Math.abs(o.forward[60]! - 0.05) < 1e-9, "last regular close 16:00");
  const pre = scorer(() => 100, 540, 500, 600).score(
    bar(day, 540, 100, 100).end,
    "up",
  );
  assert.equal(pre.result, "unscored");
  assert.equal(pre.reason, "Entry outside regular hours");
  const gap = scorer(() => 100).score(bar(day, 780, 100, 100).end, "up");
  assert.equal(gap.reason, "No bar in the minute after the alert");
  assert.throws(() => parseValidation({ stopUnits: 0 }));
});

test("summary counts results and compares with the momentum baseline", () => {
  const s = scorer((k) => 100 + k * 0.1);
  const alerts = [s.score(signal, "up"), s.score(signal, "down")];
  const baseline = s.baseline(day, day);
  const summary = summarize(alerts, baseline, parseValidation({}));
  assert.equal(summary.scored, 2);
  assert.equal(summary.good, 1);
  assert.equal(summary.stopped, 1);
  assert.ok(summary.baseline.scored > 0);
  assert.equal(
    summary.baseline.good + summary.baseline.stopped + summary.baseline.weak,
    summary.baseline.scored,
  );
});
