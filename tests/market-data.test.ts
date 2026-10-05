import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClosedMinutes,
  normalize,
  type RawBar,
} from "../packages/market-data/src/bars.js";
import {
  coreClose,
  newYork,
  previousSessions,
} from "../packages/market-data/src/calendar.js";
import { LiveEvaluator } from "../packages/market-data/src/evaluator.js";
import { defaults } from "../packages/alerts/src/relative-volume.js";
import { MarketStore } from "../packages/market-data/src/store.js";

const raw = (time: string, volume = 100): RawBar => ({
  start: Date.parse(time) / 1000,
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume,
});
test("cumulative updates replace volume, close once, ignore older updates", () => {
  const minutes = new ClosedMinutes();
  assert.equal(minutes.push(raw("2026-09-18T15:00:00Z", 100)), null);
  assert.equal(minutes.push(raw("2026-09-18T15:00:00Z", 150)), null);
  assert.equal(minutes.push(raw("2026-09-18T14:59:00Z", 999)), null);
  assert.equal(minutes.push(raw("2026-09-18T15:01:00Z"))?.volume, 150);
  assert.equal(minutes.push(raw("2026-09-18T15:01:00Z")), null);
});
test("normalization uses start for session and end for evaluation, preserves DST and volume units", () => {
  const pre = normalize("NVDA", raw("2026-09-18T13:29:00Z"), "lots")!;
  assert.equal(pre.session, "pre");
  assert.equal(pre.minute, 570);
  assert.equal(pre.volume, 10000);
  assert.equal(
    normalize("NVDA", raw("2026-09-18T13:30:00Z"), "shares")?.session,
    "regular",
  );
  assert.equal(
    normalize("NVDA", raw("2026-09-18T19:59:00Z"), "shares")?.session,
    "regular",
  );
  assert.equal(
    normalize("NVDA", raw("2026-09-18T20:00:00Z"), "shares")?.session,
    "post",
  );
  assert.equal(newYork(Date.parse("2026-03-06T16:00:00Z")).minute, 660);
  assert.equal(newYork(Date.parse("2026-03-09T15:00:00Z")).minute, 660);
  assert.throws(() =>
    normalize("NVDA", raw("2026-09-18T15:00:00Z", -1), "shares"),
  );
});
test("holidays and shortened sessions fail closed outside calendar coverage", () => {
  assert.equal(coreClose("2026-07-03"), null);
  assert.equal(coreClose("2026-11-27"), 780);
  assert.deepEqual(previousSessions("2026-09-08", 2), [
    "2026-09-03",
    "2026-09-04",
  ]);
  assert.equal(normalize("NVDA", raw("2026-11-27T18:00:00Z"), "shares"), null);
  assert.throws(() => coreClose("2029-01-02"));
  assert.throws(() => coreClose("2023-12-29"));
  // 2024–2025: holidays (incl. the 2025-01-09 national day of mourning) and
  // early closes.
  assert.equal(coreClose("2025-01-09"), null);
  assert.equal(coreClose("2024-03-29"), null);
  assert.equal(coreClose("2024-11-29"), 780);
  assert.equal(coreClose("2025-07-03"), 780);
  assert.equal(coreClose("2025-07-02"), 960);
});
test("live alert requires actual prior trading dates and never publishes warmup or stale crossings", () => {
  const config = {
    ...defaults,
    window: 1,
    days: 2,
    minVolume: 0,
    priceMultiple: 1,
    minMovePercent: 0,
    lastBarMinMovePercent: 0,
    directionBars: 1,
    paceMultiple: 0,
  };
  // Each day: a flat 10.00 bar at 10:59 New York, then the evaluated 11:00
  // bar. Baseline days rise 1%; the alert day rises 5% on 4× volume.
  const day = (e: LiveEvaluator, date: string, now: number, live: boolean) => {
    const bar = (time: string, close: number, volume: number) =>
      normalize(
        "NVDA",
        {
          start: Date.parse(`${date}T${time}:00Z`) / 1000,
          open: 10,
          high: close,
          low: 10,
          close,
          volume,
        },
        "shares",
      )!;
    const alertDay = date === "2026-09-18";
    e.push(bar("14:59", 10, 100), now, live);
    return e.push(
      bar("15:00", alertDay ? 10.5 : 10.1, alertDay ? 400 : 100),
      now,
      live,
    );
  };
  const now = Date.parse("2026-09-18T15:01:05Z");
  const ok = new LiveEvaluator(config);
  assert.equal(day(ok, "2026-09-16", now, false), null);
  day(ok, "2026-09-17", now, false);
  const alert = day(ok, "2026-09-18", now, true);
  assert.equal(alert?.status, "alert");
  assert.equal(alert?.direction, "up");
  const missing = new LiveEvaluator(config);
  day(missing, "2026-09-15", now, false);
  day(missing, "2026-09-17", now, false);
  assert.equal(
    day(missing, "2026-09-18", now, true)?.status,
    "insufficient-history",
  );
  const stale = new LiveEvaluator(config);
  day(stale, "2026-09-16", now, false);
  day(stale, "2026-09-17", now, false);
  assert.equal(day(stale, "2026-09-18", now + 300000, true), null);
});
test("durable bars survive restart, deduplicate and preserve corrected volume", () => {
  const dir = mkdtempSync(join(tmpdir(), "sma-"));
  try {
    const path = join(dir, "market.sqlite");
    const bar = normalize("NVDA", raw("2026-09-18T15:00:00Z"), "shares")!;
    const store = new MarketStore(path);
    store.put(bar);
    store.put({ ...bar, volume: 500 });
    store.close();
    const reopened = new MarketStore(path);
    assert.equal(reopened.bars("NVDA", "2026-09-01").length, 1);
    assert.equal(reopened.bars("NVDA", "2026-09-01")[0]?.volume, 500);
    reopened.prune("2026-09-19");
    assert.equal(reopened.bars("NVDA", "2026-09-01").length, 0);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("bars of another feed are dropped; the live symbol list persists", () => {
  const dir = mkdtempSync(join(tmpdir(), "sma-"));
  try {
    const path = join(dir, "market.sqlite");
    const bar = normalize("NVDA", raw("2026-09-18T15:00:00Z"), "shares")!;
    const store = new MarketStore(path);
    store.put(bar);
    // Bars stored before the feed was recorded (the IEX era) are unknown.
    assert.equal(store.barsFeed(), null);
    assert.equal(store.resetBars("sip"), 1);
    assert.equal(store.barsFeed(), "sip");
    assert.equal(store.bars("NVDA", "2026-09-01").length, 0);
    store.put(bar);
    assert.equal(store.liveSymbols(), null);
    store.setLiveSymbols(["AMD", "NVDA"]);
    store.close();
    const reopened = new MarketStore(path);
    assert.equal(reopened.barsFeed(), "sip");
    assert.equal(reopened.bars("NVDA", "2026-09-01").length, 1);
    assert.deepEqual(reopened.liveSymbols(), ["AMD", "NVDA"]);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
