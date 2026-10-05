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
  threshold: 3, // the fixtures below are built for 3× (the default until 2026-10-05)
  window: 1,
  days: 1,
  minVolume: 0,
  directionBars: 1,
  paceMultiple: 0,
};
function today(open: number, close: number, volume = 300, config = unit) {
  const engine = new RelativeVolume(config);
  engine.push(bar("2026-03-02", 660, 100, 100, 100));
  engine.push(bar("2026-03-02", 661, 100, 100.2, 100));
  engine.push(bar("2026-03-03", 660, 100, 100, 100));
  return engine.push(bar("2026-03-03", 661, open, close, volume))!;
}

// The synthetic demo was built for 3× volume, the default until 2026-10-05.
const demoConfig: Config = { ...defaults, threshold: 3, paceMultiple: 3 };

test("demo: volume, meaningful move and one direction alert once; the past is fixed", () => {
  const bars = demoBars();
  const results = replay(bars, demoConfig);
  const alerts = results.filter((r) => r.status === "alert");
  assert.equal(alerts.length, 1);
  const [alert] = alerts;
  assert.equal(alert!.ticker, "NVDA");
  // Window 11:09–11:11: 100.00 → 100.05 → 100.65 → 101.25, all green, on
  // 10,000 + 50,000 + 50,000 shares against a 30,000 baseline.
  assert.equal(alert!.end.slice(11, 16), "15:11");
  assert.equal(alert!.actual, 110000);
  assert.equal(alert!.expected, 30000);
  assert.ok(Math.abs(alert!.ratio! - 110000 / 30000) < 1e-12);
  assert.equal(alert!.direction, "up");
  assert.ok(Math.abs(alert!.move - 1.25) < 1e-9);
  assert.equal(alert!.volumeBasis, "history");
  assert.equal(alert!.samples, 20);
  assert.equal(alert!.rule, "rvol-v4");
  const cutoff = alert!.end;
  assert.deepEqual(
    replay(
      bars.filter((b) => b.end <= cutoff),
      demoConfig,
    ),
    results.filter((r) => r.end <= cutoff),
  );
  // Each of these settings blocks the 15:11 anomaly. (With one candle, the
  // demo's 15:20 drop also qualifies; on defaults the cooldown suppresses it.)
  for (const config of [
    { ...demoConfig, threshold: 6 },
    // The steepest demo window moves 3 × 0.6 ≈ 1.8%.
    { ...demoConfig, minMovePercent: 2 },
    { ...demoConfig, lastBarMinMovePercent: 0.7 },
  ])
    assert.equal(
      replay(bars, config).filter(
        (r) => r.status === "alert" && r.end === cutoff,
      ).length,
      0,
    );
  assert.equal(
    results.find(
      (r) => r.end === "2026-03-30T15:20:00.000Z" && r.ticker === "NVDA",
    )?.status,
    "suppressed",
  );
});

test("price move is relative to the symbol's time-of-day median and has a floor", () => {
  assert.equal(today(100, 101).status, "alert");
  // 0.55%: above the 0.5% floor but below 3 × 0.2%.
  assert.equal(today(100, 100.55).status, "small-move");
  // Baseline of 0.1%: 3× is 0.3%, so the 0.5% floor decides.
  const quiet = new RelativeVolume({ ...unit, lastBarMinMovePercent: 0 });
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
  // Three-minute window with directionBars 3 (v3): a middle bar that dips
  // breaks the staircase. v4's default (1) needs only the last candle.
  const run = (directionBars: number) => {
    const engine = new RelativeVolume({
      ...defaults,
      threshold: 3, // fixture volume is 3× the baseline
      days: 1,
      minVolume: 0,
      paceMultiple: 0,
      directionBars,
    });
    const day = (date: string, closes: number[], volume: number) =>
      closes.map((c, i) =>
        engine.push(
          bar(date, 660 + i, i ? closes[i - 1]! : c, c, i ? volume : 100),
        ),
      );
    day("2026-03-02", [100, 100.1, 100.2, 100.3], 100);
    return day("2026-03-03", [100, 101, 100.9, 102], 300).at(-1)!;
  };
  assert.equal(run(3).status, "mixed-direction");
  assert.equal(defaults.directionBars, 1);
  assert.equal(run(defaults.directionBars).status, "alert");
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

// Pace scenarios: one baseline day at 1,000 shares a minute, then a quiet day
// at 100 shares a minute that jumps to 500 shares with a 1% green minute. The
// jump is only 0.5× the 20-day style baseline but 5× today's own pace.
function paceDay(
  minutes: [number, number],
  jumpAt: number,
  overrides: Partial<Config> = {},
  regularClose?: number,
) {
  const engine = new RelativeVolume({
    ...unit,
    priceMultiple: 1,
    minMovePercent: 0,
    paceMultiple: 3,
    ...overrides,
  });
  const run = (date: string, quiet: boolean) => {
    let close = 100;
    let result;
    for (let m = minutes[0]; m <= minutes[1]; m++) {
      const jump = !quiet ? false : m === jumpAt;
      const open = close;
      close = jump ? close * 1.01 : m % 2 ? 100.1 : 100;
      result = engine.push({
        ...bar(date, m, open, close, jump ? 500 : quiet ? 100 : 1000),
        regularClose,
      });
      if (jump) return result;
    }
    return result;
  };
  run("2026-03-02", false);
  return run("2026-03-03", true)!;
}

test("a sudden jump on a quiet day alerts against today's pace", () => {
  const r = paceDay([601, 640], 630);
  assert.equal(r.status, "alert");
  assert.equal(r.volumeBasis, "pace");
  assert.ok(r.ratio! < 3);
  assert.equal(r.paceRatio, 5);
  // Pace off: only the 20-day baseline counts, which the jump does not beat.
  assert.equal(
    paceDay([601, 640], 630, { paceMultiple: 0 }).status,
    "below-threshold",
  );
});

test("today's pace skips the open and close and needs 15 minutes of data", () => {
  // Opening half hour (09:30–10:00 New York): baseline only.
  assert.equal(paceDay([571, 600], 595).status, "below-threshold");
  // Only 10 pace-zone minutes before the jump.
  assert.equal(paceDay([601, 612], 611).status, "below-threshold");
  // Last half hour before a 16:00 close.
  assert.equal(paceDay([900, 959], 945).status, "below-threshold");
  assert.equal(paceDay([900, 959], 925).status, "alert");
  // Early-close day (13:00): the pace zone ends at 12:30.
  assert.equal(paceDay([700, 779], 765, {}, 780).status, "below-threshold");
  assert.equal(paceDay([700, 779], 745, {}, 780).status, "alert");
});

test("the last-minute gate and the number of same-direction candles are configurable", () => {
  // Last minute +0.3% after two strong minutes.
  const engine = (config: Partial<Config>) => {
    const e = new RelativeVolume({
      ...defaults,
      threshold: 3, // fixture volume is 3× the baseline
      days: 1,
      minVolume: 0,
      paceMultiple: 0,
      ...config,
    });
    const day = (date: string, closes: number[], volume: number) =>
      closes.map((c, i) =>
        e.push(bar(date, 660 + i, i ? closes[i - 1]! : c, c, i ? volume : 100)),
      );
    day("2026-03-02", [100, 100.1, 100.2, 100.3], 100);
    return day;
  };
  const gentle = [100, 101, 102, 102.3];
  // Off by default; opt in with a percentage.
  assert.equal(
    engine({ lastBarMinMovePercent: 0.5 })("2026-03-03", gentle, 300).at(-1)
      ?.status,
    "weak-last-bar",
  );
  assert.equal(engine({})("2026-03-03", gentle, 300).at(-1)?.status, "alert");
  // First window minute dips; only the last two must share the direction.
  const dip = [100, 99.5, 100.5, 101.5];
  assert.equal(
    engine({ directionBars: 3 })("2026-03-03", dip, 300).at(-1)?.status,
    "mixed-direction",
  );
  assert.equal(
    engine({ directionBars: 2 })("2026-03-03", dip, 300).at(-1)?.status,
    "alert",
  );
  assert.throws(() => new RelativeVolume({ ...defaults, directionBars: 4 }));
});

// v4: ten quiet past sessions (100 shares and ±0.05% each minute, 09:31–10:41),
// then today: `todayVolume` shares and `swing`% moves each minute until 10:40,
// and a 10:41 burst of `burst` shares moving +1%. One-minute window.
function v4Day(
  { todayVolume = 100, swing = 0.05, burst = 800 },
  config: Partial<Config> = {},
) {
  const engine = new RelativeVolume({
    ...defaults,
    window: 1,
    days: 10,
    minVolume: 0,
    paceMultiple: 0,
    ...config,
  });
  const run = (date: string, volume: number, pct: number, until = 640) => {
    let close = 100;
    for (let m = 571; m <= until; m++) {
      const open = close;
      close = m % 2 ? 100 * (1 + pct / 100) : 100;
      engine.push(bar(date, m, open, close, volume));
    }
    return close;
  };
  for (let d = 1; d <= 10; d++)
    run(`2026-03-${String(d).padStart(2, "0")}`, 100, 0.05, 641);
  const last = run("2026-03-11", todayVolume, swing);
  return engine.push(bar("2026-03-11", 641, last, last * 1.01, burst))!;
}

test("v4 tags an alert in play when today's volume is ≥ 2× its usual level", () => {
  const quiet = v4Day({});
  assert.equal(quiet.status, "alert");
  assert.equal(quiet.inPlay, false);
  assert.ok(Math.abs(quiet.dayRvol! - (70 * 100 + 800) / (71 * 100)) < 1e-9);
  const busy = v4Day({ todayVolume: 300 });
  assert.equal(busy.status, "alert");
  assert.equal(busy.inPlay, true);
  assert.ok(Math.abs(busy.dayRvol! - (70 * 300 + 800) / (71 * 100)) < 1e-9);
  // The tag never blocks, and 0 turns it off.
  assert.equal(v4Day({ todayVolume: 300 }, { inPlayDayRvol: 0 }).inPlay, false);
});

test("N1 (optional) needs a bigger burst on a busy day", () => {
  // 8× usual volume: on a 3.07× day that is only 2.6× relative to today.
  assert.equal(
    v4Day({ todayVolume: 300 }, { todayVolumeMultiple: 3 }).status,
    "busy-day-volume",
  );
  assert.equal(v4Day({}, { todayVolumeMultiple: 3 }).status, "alert");
  assert.equal(
    v4Day({ todayVolume: 300, burst: 1200 }, { todayVolumeMultiple: 3 }).status,
    "alert",
  );
});

test("N2 (optional) skips a move that is normal for today", () => {
  // Today swings 0.5% a minute, so a 1% minute is only 2× today's typical move.
  const wild = v4Day({ swing: 0.5 }, { todayMoveMultiple: 3 });
  assert.equal(wild.status, "normal-for-today");
  // +0.5% up and −0.4975% back: the median is just under 0.5%.
  assert.ok(Math.abs(wild.todayMove! - 0.5) < 0.01);
  // Off by default; a calm day passes when on.
  assert.equal(v4Day({ swing: 0.5 }).status, "alert");
  assert.equal(v4Day({}, { todayMoveMultiple: 3 }).status, "alert");
  // Before 15 minutes of today the check does not apply.
  const engine = new RelativeVolume({ ...unit, todayMoveMultiple: 3 });
  engine.push(bar("2026-03-02", 600, 100, 100, 100));
  engine.push(bar("2026-03-02", 601, 100, 100.2, 100));
  engine.push(bar("2026-03-03", 600, 100, 100, 100));
  const early = engine.push(bar("2026-03-03", 601, 100, 101, 300))!;
  assert.equal(early.status, "alert");
  assert.equal(early.todayMove, null);
});

test("v4 settings are validated", () => {
  for (const bad of [
    { inPlayDayRvol: -1 },
    { todayVolumeMultiple: Number.NaN },
    { todayMoveMultiple: 101 },
  ])
    assert.throws(() => new RelativeVolume({ ...defaults, ...bad }));
});
