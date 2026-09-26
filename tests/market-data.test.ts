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
});
test("live alert requires actual prior trading dates and never publishes warmup or stale crossings", () => {
  const config = {
    window: 1,
    days: 2,
    threshold: 3,
    cooldown: 15,
    minVolume: 0,
  };
  const b = (date: string, v = 100) =>
    normalize("NVDA", raw(`${date}T15:00:00Z`, v), "shares")!;
  const now = Date.parse("2026-09-18T15:01:05Z");
  const ok = new LiveEvaluator(config);
  assert.equal(ok.push(b("2026-09-16"), now, false), null);
  ok.push(b("2026-09-17"), now, false);
  assert.equal(ok.push(b("2026-09-18", 400), now, true)?.status, "alert");
  assert.equal(ok.push(b("2026-09-18", 400), now, true), null);
  const missing = new LiveEvaluator(config);
  missing.push(b("2026-09-15"), now, false);
  missing.push(b("2026-09-17"), now, false);
  assert.equal(
    missing.push(b("2026-09-18", 400), now, true)?.status,
    "insufficient-history",
  );
  const stale = new LiveEvaluator(config);
  stale.push(b("2026-09-16"), now, false);
  stale.push(b("2026-09-17"), now, false);
  assert.equal(stale.push(b("2026-09-18", 400), now + 300000, true), null);
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
