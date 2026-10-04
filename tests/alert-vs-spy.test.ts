// SYNTHETIC market data: area score vs SPY at alert time and now in the
// collector (docs/features/area-vs-spy.md; SPY wait from alert-vs-spy.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AlertEvent } from "../packages/alerts/src/events.js";
import { formatAlert } from "../packages/notifications/src/telegram.js";
import { normalize, type PriceBar } from "../packages/market-data/src/bars.js";
import {
  alertedToday,
  LiveStrength,
  raiseScored,
} from "../packages/market-data/src/live-strength.js";
import {
  areaSeries,
  fromPriceBar,
  type SigmaCurve,
} from "../packages/market-data/src/area-vs-spy.js";
import type { SpyStrength } from "../packages/market-data/src/rs-score.js";
import { MemoryDailyStore } from "../packages/market-data/src/volume-baseline.js";
import {
  newYorkToUtc,
  previousSessions,
} from "../packages/market-data/src/calendar.js";
import { alert, alertEnd, day } from "./analysis-fixtures.js";

const unit: SpyStrength = {
  beta: 1,
  betaAssumed: false,
  betaReturns: 60,
  sigma: 1.2,
};
const sigma = (value: number): SigmaCurve => ({
  pre: new Array(330).fill(value),
  regular: new Array(390).fill(value),
  post: new Array(240).fill(value),
});

function bar(
  ticker: string,
  date: string,
  minute: number,
  close: number,
  open = close,
): PriceBar {
  const start = newYorkToUtc(date, minute) / 1000;
  return normalize(
    ticker,
    {
      start,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume: 1000,
    },
    "shares",
  )!;
}
/** Bars at every minute from..to; the first opens at `open`. */
const run = (
  ticker: string,
  from: number,
  to: number,
  close: (t: number) => number,
  open: number,
  date = day,
) =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    bar(ticker, date, from + i, close(from + i), i ? close(from + i) : open),
  );

// NVDA opens 100 at 09:30 and closes 101 every minute (+1%); SPY flat at
// 500. The alert bar is 10:29–10:30 (start minute 629).
function setup(
  options: {
    strength?: SpyStrength | null;
    sigma?: SigmaCurve | null;
    spyTo?: number;
    waitMs?: number;
  } = {},
) {
  const stored: PriceBar[] = [
    ...run("NVDA", 570, 629, () => 101, 100),
    ...run("SPY", 570, options.spyTo ?? 629, () => 500, 500),
  ];
  const strengths = new MemoryDailyStore<SpyStrength>();
  if (options.strength !== null)
    strengths.rows.set(`${day}|NVDA`, options.strength ?? unit);
  const sigmas = new MemoryDailyStore<SigmaCurve>();
  if (options.sigma !== null)
    sigmas.rows.set(`${day}|NVDA`, options.sigma ?? sigma(1));
  const strength = new LiveStrength({
    multi: async () => {
      throw new Error("no daily request expected");
    },
    store: strengths,
    sigmas,
    bars: (ticker, from) =>
      stored.filter((b) => b.ticker === ticker && b.date >= from),
    waitMs: options.waitMs,
    now: () => Date.parse(alertEnd),
  });
  return { strength, stored, sigmas };
}

const nvdaAlert = (overrides: Partial<AlertEvent> = {}) =>
  alert({ ticker: "NVDA", close: 101, move: 0.8, ...overrides });

async function ready(s: LiveStrength) {
  await s.prepare(day, ["NVDA"]);
  await s.prepareSigma(day, ["NVDA"]);
}

test("alert score: 1 pt above SPY all window with σ 1 → 84, one Telegram line", async () => {
  const { strength, stored } = setup();
  await ready(strength);
  strength.bar(stored.at(-1)!); // SPY's 10:29 bar
  const vsSpy = await strength.atAlert(nvdaAlert());
  assert.deepEqual(vsSpy, {
    score: 84,
    area: 1,
    beta: 1,
    betaAssumed: false,
    spyLagged: false,
  });
  const lines = formatAlert({ ...nvdaAlert(), vsSpy }).split("\n");
  assert.equal(lines[0], "<b>NVDA</b> · big move likely");
  assert.equal(lines[1], "vs SPY 84/100");
  for (const word of ["confirmed", "against", "with market", "Long", "Short"])
    assert.ok(!lines.join("\n").includes(word), word);
});

test("scenario 7: the alert's score equals the chart's score at that minute", async () => {
  const { strength, stored } = setup();
  await ready(strength);
  strength.bar(stored.at(-1)!);
  const live = await strength.atAlert(nvdaAlert());
  const nvda = stored.filter((b) => b.ticker === "NVDA").map(fromPriceBar);
  const spy = stored.filter((b) => b.ticker === "SPY").map(fromPriceBar);
  const chart = areaSeries(
    { ticker: "NVDA", stock: nvda, spy, date: day, beta: 1, sigma: sigma(1) },
    nvda,
  );
  assert.equal(chart.score.at(-1), live.score);
});

test("without σ the score is null and the alert still goes out", async () => {
  const { strength, stored } = setup({ sigma: null });
  await strength.prepare(day, ["NVDA"]);
  strength.bar(stored.at(-1)!);
  const vsSpy = await strength.atAlert(nvdaAlert());
  assert.equal(vsSpy.score, null);
  assert.equal(vsSpy.area, 1);
  assert.equal(
    formatAlert({ ...nvdaAlert(), vsSpy }).split("\n")[1],
    "vs SPY —",
  );
  // β never prepared (daily request failed): no σ curve is computed (it
  // must use the date's β); β 1 assumed, area still reported.
  const missing = setup({ strength: null, sigma: null });
  assert.equal(await missing.strength.prepareSigma(day, ["NVDA"]), 1);
  missing.strength.bar(missing.stored.at(-1)!);
  assert.deepEqual(await missing.strength.atAlert(nvdaAlert()), {
    score: null,
    area: 1,
    beta: 1,
    betaAssumed: true,
    spyLagged: false,
  });
});

test("a failed daily request is reported as missing and retried", async () => {
  let calls = 0;
  const strength = new LiveStrength({
    multi: async () => {
      calls++;
      throw new Error("Alpaca REST request failed (500)");
    },
    store: new MemoryDailyStore<SpyStrength>(),
    bars: () => [],
  });
  assert.equal(await strength.prepare(day, ["NVDA", "AAPL"]), 2);
  assert.equal(await strength.prepare(day, ["NVDA", "AAPL"]), 2);
  assert.equal(calls, 2);
});

test("SPY's bar 1 s late is used; 5 s late → carried forward, lagged, ≤ 3 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = setup({ spyTo: 628 });
  await ready(first.strength);
  first.strength.bar(first.stored.at(-1)!); // SPY's 10:28 bar
  let done = false;
  const late = first.strength.atAlert(nvdaAlert()).finally(() => (done = true));
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(done, false, "still waiting for SPY's bar");
  const spy629 = bar("SPY", day, 629, 500);
  first.stored.push(spy629);
  first.strength.bar(spy629);
  const used = await late;
  assert.equal(used.spyLagged, false);
  assert.equal(used.score, 84);

  const second = setup({ spyTo: 628 });
  await ready(second.strength);
  second.strength.bar(second.stored.at(-1)!);
  let finished = false;
  const lagged = second.strength
    .atAlert(nvdaAlert())
    .finally(() => (finished = true));
  t.mock.timers.tick(2999);
  await Promise.resolve();
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  const result = await lagged;
  assert.equal(finished, true, "resolved at 3 s, before SPY's bar at 5 s");
  assert.equal(result.spyLagged, true);
  assert.equal(result.score, 84); // SPY's 10:28 close carried forward
});

test("the alert is stored and published with vsSpy attached", async () => {
  const { strength, stored } = setup();
  await ready(strength);
  strength.bar(stored.at(-1)!);
  const order: string[] = [];
  const kept: AlertEvent[] = [];
  const store = {
    alert(a: AlertEvent) {
      order.push("store");
      kept.push(a);
      return kept.filter((s) => s.end === a.end).length === 1;
    },
  };
  const events = {
    publish(a: AlertEvent) {
      order.push("publish");
      assert.equal(a.vsSpy?.score, 84);
    },
  };
  await raiseScored(nvdaAlert(), strength, store, events);
  await raiseScored(nvdaAlert(), strength, store, events);
  assert.deepEqual(order, ["store", "publish", "store"]);
  assert.equal(kept[0]!.vsSpy?.label, undefined);
});

test("strength now is the area score ending at each symbol's latest bar", async () => {
  const { strength, stored } = setup();
  await ready(strength);
  // NVDA falls back to its open by 10:49; SPY's later bar is ignored.
  for (let t = 630; t <= 649; t++) {
    const b = bar("NVDA", day, t, 100);
    stored.push(b);
    strength.bar(b);
  }
  stored.push(...run("SPY", 630, 655, () => 500, 500));
  const now = strength.current(["NVDA", "AAPL"]);
  // Area of weights 1…80: (Σ1..60) / (Σ1..80) = 1830 / 3240.
  assert.deepEqual(now, {
    NVDA: {
      score: Math.round(100 * 0.5 * (1 + erf(1830 / 3240 / Math.SQRT2))),
      at: bar("NVDA", day, 649, 1).end,
    },
  });
});

// Reference erf for the test only (series; adequate for |x| < 2).
function erf(x: number) {
  let sum = 0;
  let term = x;
  for (let n = 0; n < 60; n++) {
    sum += term / (2 * n + 1);
    term *= (-x * x) / (n + 1);
  }
  return (2 / Math.sqrt(Math.PI)) * sum;
}

test("σ curves come from 20 stored sessions, are stored, and need 15", async () => {
  const prior = previousSessions(day, 20);
  const history = (dates: string[]) =>
    dates.flatMap((date, i) => [
      ...run("NVDA", 570, 700, () => (i % 2 ? 98 : 101), 100, date),
      ...run("SPY", 570, 700, () => 500, 500, date),
    ]);
  const make = (stored: PriceBar[]) => {
    const sigmas = new MemoryDailyStore<SigmaCurve>();
    const strengths = new MemoryDailyStore<SpyStrength>();
    strengths.rows.set(`${day}|NVDA`, unit);
    let reads = 0;
    const s = new LiveStrength({
      multi: async () => new Map(),
      store: strengths,
      sigmas,
      bars: (ticker, from) => {
        reads++;
        return stored.filter((b) => b.ticker === ticker && b.date >= from);
      },
    });
    return { s, sigmas, reads: () => reads };
  };
  const full = make(history(prior));
  await full.s.prepare(day, ["NVDA"]);
  assert.equal(await full.s.prepareSigma(day, ["NVDA", "SPY"]), 0);
  const curve = full.sigmas.rows.get(`${day}|NVDA`)!;
  // RMS of +1 and −2 alternating: √2.5.
  assert.ok(Math.abs(curve.regular[650 - 570]! - Math.sqrt(2.5)) < 1e-3);
  assert.equal(full.sigmas.rows.has(`${day}|SPY`), false, "SPY is not scored");
  // A new instance reads the stored curve without touching the bars.
  const again = new LiveStrength({
    multi: async () => new Map(),
    store: new MemoryDailyStore<SpyStrength>(),
    sigmas: full.sigmas,
    bars: () => {
      throw new Error("no bar read expected");
    },
  });
  assert.equal(await again.prepareSigma(day, ["NVDA"]), 0);
  assert.equal(again.sigma(day, "NVDA"), curve);
  // 14 of 20 sessions: no σ.
  const sparse = make(history(prior.slice(6)));
  await sparse.s.prepare(day, ["NVDA"]);
  await sparse.s.prepareSigma(day, ["NVDA"]);
  assert.equal(sparse.s.sigma(day, "NVDA")!.regular[80], null);
  // Without SPY's history nothing is computed (retried later).
  const noSpy = make(history(prior).filter((b) => b.ticker !== "SPY"));
  await noSpy.s.prepare(day, ["NVDA"]);
  assert.equal(await noSpy.s.prepareSigma(day, ["NVDA"]), 1);
  assert.equal(noSpy.sigmas.rows.size, 0);
});

test("alerted today is the Israel calendar day", () => {
  const now = Date.parse("2026-09-28T22:30:00Z"); // 01:30 on the 29th, Israel
  assert.deepEqual(
    alertedToday(
      [
        { ticker: "NVDA", end: "2026-09-28T21:05:00Z" }, // 00:05 Israel, 29th
        { ticker: "AAPL", end: "2026-09-28T20:55:00Z" }, // 23:55 Israel, 28th
        { ticker: "NVDA", end: "2026-09-28T22:00:00Z" },
      ],
      now,
    ),
    ["NVDA"],
  );
});
