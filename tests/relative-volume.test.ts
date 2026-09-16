import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaults,
  replay,
  RelativeVolume,
} from "../packages/alerts/src/relative-volume.js";
import { demoBars } from "../packages/alerts/src/demo.js";
import { buildApp } from "../apps/api/src/app.js";

test("same-time baseline detects a spike once; future bars cannot change earlier results", () => {
  const bars = demoBars();
  const results = replay(bars);
  const alerts = results.filter((r) => r.status === "alert");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.ticker, "NVDA");
  assert.equal(alerts[0]!.expected, 50000);
  assert.equal(alerts[0]!.ratio, 3.4);
  assert.equal(alerts[0]!.samples, 20);
  const cutoff = alerts[0]!.end;
  assert.deepEqual(
    replay(bars.filter((b) => b.end <= cutoff)),
    results.filter((r) => r.end <= cutoff),
  );
  assert.equal(
    replay(bars, { ...defaults, threshold: 6 }).filter(
      (r) => r.status === "alert",
    ).length,
    0,
  );
});
test("missing minutes cannot manufacture windows or substitute historical samples", () => {
  const bars = demoBars();
  const missing = bars.filter(
    (b) =>
      !(b.ticker === "NVDA" && b.date === "2026-03-02" && b.minute === 672),
  );
  const r = replay(missing).find(
    (r) =>
      r.ticker === "NVDA" &&
      r.end.startsWith("2026-03-30") &&
      r.end.includes(":12:"),
  );
  assert.equal(r?.status, "insufficient-history");
  assert.equal(r?.samples, 19);
});
test("session separation, exact threshold, zero baseline, duplicate rejection and cooldown", () => {
  const sample = demoBars()[0]!;
  const engine = new RelativeVolume({
    ...defaults,
    window: 1,
    days: 1,
    minVolume: 0,
  });
  engine.push({ ...sample, volume: 100 });
  const next = {
    ...sample,
    date: "2026-03-03",
    end: "2026-03-03T16:00:00.000Z",
    volume: 300,
  };
  assert.equal(engine.push(next)?.status, "alert");
  assert.throws(() => engine.push(next), /Duplicate/);
  assert.equal(
    engine.push({ ...next, session: "post" })?.status,
    "insufficient-history",
  );
  const zero = new RelativeVolume({ ...defaults, window: 1, days: 1 });
  zero.push({ ...sample, volume: 0 });
  assert.equal(zero.push(next)?.status, "zero-baseline");
  const all = demoBars().filter((b) => b.ticker === "NVDA");
  const currentDate = all.at(-1)!.date;
  const modified = all.map((b) => ({
    ...b,
    volume:
      b.date === currentDate && [670, 672, 686].includes(b.minute)
        ? 50000
        : 10000,
  }));
  const alerts = replay(modified, { ...defaults, window: 1 }).filter(
    (r) => r.status === "alert",
  );
  assert.equal(alerts.length, 2);
});
test("API validates configuration and supports demo and uploaded replay", async () => {
  const app = buildApp();
  try {
    const good = await app.inject({
      method: "POST",
      url: "/api/replay",
      payload: {},
    });
    assert.equal(good.statusCode, 200);
    assert.equal(good.json().alerts.length, 1);
    assert.equal(good.json().source, "synthetic-demo");
    const bad = await app.inject({
      method: "POST",
      url: "/api/replay",
      payload: { config: { threshold: 0 } },
    });
    assert.equal(bad.statusCode, 400);
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/replay",
      payload: { bars: [] },
    });
    assert.equal(uploaded.json().source, "uploaded");
  } finally {
    await app.close();
  }
});
