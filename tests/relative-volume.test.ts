import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaults,
  replay,
  RelativeVolume,
  type Bar,
  type Config,
} from "../packages/alerts/src/relative-volume.js";
import { demoBars } from "../packages/alerts/src/demo.js";
import { buildApp } from "../apps/api/src/app.js";

// Regular-session bar at New York minute `minute` (660 = 11:00) on `date`.
function bar(
  date: string,
  minute: number,
  open: number,
  close: number,
  volume: number,
  ticker = "NVDA",
): Bar {
  return {
    ticker,
    date,
    end: new Date(
      Date.parse(`${date}T15:00:00Z`) + (minute - 660) * 60000,
    ).toISOString(),
    minute,
    session: "regular",
    volume,
    open,
    close,
  };
}
// One-minute window, one baseline day: yesterday 100.00 → 100.20 (0.2%) on 100
// shares, so today needs ≥ 300 shares and a move ≥ 0.6% (3×) and ≥ 0.5%.
const unit: Config = {
  ...defaults,
  window: 1,
  days: 1,
  minVolume: 0,
};
function today(open: number, close: number, volume = 300, config = unit) {
  const engine = new RelativeVolume(config);
  engine.push(bar("2026-03-02", 660, 100, 100, 100));
  engine.push(bar("2026-03-02", 661, 100, 100.2, 100));
  engine.push(bar("2026-03-03", 660, 100, 100, 100));
  return engine.push(bar("2026-03-03", 661, open, close, volume))!;
}

test("demo: volume, meaningful move and one direction alert once; the past is fixed", () => {
  const bars = demoBars();
  const results = replay(bars);
  const alerts = results.filter((r) => r.status === "alert");
  assert.equal(alerts.length, 1);
  const [alert] = alerts;
  assert.equal(alert!.ticker, "NVDA");
  // Window 11:09–11:11: 100.00 → 100.05 → 100.45 → 100.85, all green, on
  // 10,000 + 50,000 + 50,000 shares against a 30,000 baseline.
  assert.equal(alert!.end.slice(11, 16), "15:11");
  assert.equal(alert!.actual, 110000);
  assert.equal(alert!.expected, 30000);
  assert.ok(Math.abs(alert!.ratio! - 110000 / 30000) < 1e-12);
  assert.equal(alert!.direction, "up");
  assert.ok(Math.abs(alert!.move - 0.85) < 1e-9);
  assert.equal(alert!.samples, 20);
  assert.equal(alert!.rule, "rvol-v2");
  const cutoff = alert!.end;
  assert.deepEqual(
    replay(bars.filter((b) => b.end <= cutoff)),
    results.filter((r) => r.end <= cutoff),
  );
  for (const config of [
    { ...defaults, threshold: 6 },
    { ...defaults, minMovePercent: 1.5 },
  ])
    assert.equal(
      replay(bars, config).filter((r) => r.status === "alert").length,
      0,
    );
});

test("price move is relative to the symbol's time-of-day median and has a floor", () => {
  assert.equal(today(100, 101).status, "alert");
  // 0.55%: above the 0.5% floor but below 3 × 0.2%.
  assert.equal(today(100, 100.55).status, "small-move");
  // Baseline of 0.1%: 3× is 0.3%, so the 0.5% floor decides.
  const quiet = new RelativeVolume(unit);
  quiet.push(bar("2026-03-02", 660, 100, 100, 100));
  quiet.push(bar("2026-03-02", 661, 100, 100.1, 100));
  quiet.push(bar("2026-03-03", 660, 100, 100, 100));
  assert.equal(
    quiet.push(bar("2026-03-03", 661, 100, 100.45, 300))?.status,
    "small-move",
  );
  const down = today(100, 99);
  assert.equal(down.status, "alert");
  assert.equal(down.direction, "down");
  assert.ok(Math.abs(down.move + 1) < 1e-9);
});

test("every close must pass the previous close and every candle must share the color", () => {
  // Close above the prior close, but a red candle.
  assert.equal(today(101.5, 101).status, "mixed-direction");
  // Green candle, but closing below the prior close.
  assert.equal(today(98, 99.5).status, "mixed-direction");
  // Three-minute window: a middle bar that dips breaks the staircase.
  const engine = new RelativeVolume({ ...defaults, days: 1, minVolume: 0 });
  const day = (date: string, closes: number[], volume: number) =>
    closes.map((c, i) =>
      engine.push(
        bar(date, 660 + i, i ? closes[i - 1]! : c, c, i ? volume : 100),
      ),
    );
  day("2026-03-02", [100, 100.1, 100.2, 100.3], 100);
  const dip = day("2026-03-03", [100, 101, 100.9, 102], 300).at(-1)!;
  assert.equal(dip.status, "mixed-direction");
});

test("a low-volume crossing does not suppress the alert once volume arrives", () => {
  const engine = new RelativeVolume({ ...unit, minVolume: 250 });
  for (const [m, close] of [
    [660, 100],
    [661, 100.2],
    [662, 100.4],
  ] as const)
    engine.push(bar("2026-03-02", m, m === 660 ? 100 : close - 0.2, close, 50));
  engine.push(bar("2026-03-03", 660, 100, 100, 50));
  assert.equal(
    engine.push(bar("2026-03-03", 661, 100, 101, 200))?.status,
    "low-volume",
  );
  assert.equal(
    engine.push(bar("2026-03-03", 662, 101, 102, 300))?.status,
    "alert",
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

test("session separation, zero baseline, duplicates, fresh crossings and cooldown", () => {
  const engine = new RelativeVolume(unit);
  engine.push(bar("2026-03-02", 660, 100, 100, 100));
  engine.push(bar("2026-03-02", 661, 100, 100.2, 100));
  engine.push(bar("2026-03-03", 660, 100, 100, 100));
  const next = bar("2026-03-03", 661, 100, 101, 300);
  assert.equal(engine.push(next)?.status, "alert");
  assert.throws(() => engine.push(next), /Duplicate/);
  const post = { ...next, session: "post" as const };
  assert.equal(engine.push(post), null, "no bar before the window in post");

  const zero = new RelativeVolume(unit);
  zero.push(bar("2026-03-02", 660, 100, 100, 0));
  zero.push(bar("2026-03-02", 661, 100, 100.2, 0));
  zero.push(bar("2026-03-03", 660, 100, 100, 0));
  assert.equal(
    zero.push(bar("2026-03-03", 661, 100, 101, 300))?.status,
    "zero-baseline",
  );

  // A sustained climb alerts once; a new crossing alerts only after the
  // cooldown.
  const sequence = (cooldown: number) => {
    const run = new RelativeVolume({ ...unit, cooldown });
    for (let m = 660; m < 670; m++)
      run.push(
        bar(
          "2026-03-02",
          m,
          100 + (m - 660) * 0.2,
          100.2 + (m - 660) * 0.2,
          100,
        ),
      );
    run.push(bar("2026-03-03", 660, 100, 100, 100));
    let close = 100;
    return Array.from({ length: 9 }, (_, i) => {
      const flat = i === 3 || i === 4;
      const open = close;
      if (!flat) close += 1;
      return run.push(
        bar("2026-03-03", 661 + i, open, close, flat ? 100 : 300),
      )!.status;
    });
  };
  assert.deepEqual(sequence(3), [
    "alert",
    "suppressed",
    "suppressed",
    "below-threshold",
    "below-threshold",
    "alert",
    "suppressed",
    "suppressed",
    "suppressed",
  ]);
  assert.equal(sequence(10)[5], "suppressed", "re-crossing within cooldown");
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
    for (const config of [
      { threshold: 0 },
      { priceMultiple: 0.5 },
      { minMovePercent: -1 },
    ]) {
      const bad = await app.inject({
        method: "POST",
        url: "/api/replay",
        payload: { config },
      });
      assert.equal(bad.statusCode, 400, JSON.stringify(config));
    }
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
