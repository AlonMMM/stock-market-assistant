import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlertEvents, type AlertEvent } from "../packages/alerts/src/events.js";
import { defaults } from "../packages/alerts/src/relative-volume.js";
import { MarketStore } from "../packages/market-data/src/store.js";

// SYNTHETIC alert values.
const alert: AlertEvent = {
  ticker: "AAPL",
  end: "2026-09-28T14:00:00Z",
  session: "regular",
  actual: 50000,
  expected: 10000,
  ratio: 5,
  paceRatio: null,
  volumeBasis: "history",
  move: 1,
  expectedMove: 0.2,
  direction: "up",
  samples: 20,
  status: "alert",
  rule: "rvol-v3",
  config: defaults,
};

test("publishes to every subscriber and isolates failing ones", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const events = new AlertEvents();
  const seen: string[] = [];
  events.subscribe("throws", () => {
    throw new Error("sync boom");
  });
  events.subscribe("rejects", async () => {
    throw new Error("async boom");
  });
  const stop = events.subscribe("records", (a) => void seen.push(a.ticker));
  assert.throws(() => events.subscribe("records", () => {}), /already/);

  assert.doesNotThrow(() => events.publish(alert));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["AAPL"]);
  // Other output (such as Node warnings) may share console.error.
  const logged = errors.mock.calls
    .map((c) => String(c.arguments[0]))
    .filter((line) => line.includes('"alert-listener-failed"'))
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    logged.map((l) => [l.listener, l.error]),
    [
      ["throws", "sync boom"],
      ["rejects", "async boom"],
    ],
  );

  stop();
  events.publish(alert);
  assert.deepEqual(seen, ["AAPL"], "unsubscribed listener is not called");
});

test("the store reports whether an alert is new", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  const store = new MarketStore(join(dir, "test.sqlite"));
  try {
    assert.equal(store.alert(alert), true);
    assert.equal(store.alert({ ...alert, ratio: 6 }), false);
    assert.equal(store.alerts()[0]!.ratio, 5);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});
