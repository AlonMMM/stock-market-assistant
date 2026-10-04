// SYNTHETIC market data: score vs SPY at alert time and now
// (docs/features/alert-vs-spy.md, acceptance scenarios 1–5 and 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AlertEvent } from "../packages/alerts/src/events.js";
import { scoreAgainst } from "../packages/analysis/src/relative-strength.js";
import { formatAlert } from "../packages/notifications/src/telegram.js";
import type { PriceBar } from "../packages/market-data/src/bars.js";
import {
  alertedToday,
  LiveStrength,
  raiseScored,
} from "../packages/market-data/src/live-strength.js";
import type { SpyStrength } from "../packages/market-data/src/rs-score.js";
import { MemoryDailyStore } from "../packages/market-data/src/volume-baseline.js";
import {
  alert,
  alertEnd,
  day,
  dayBars,
  minuteBar,
  pairedDaily,
  previous,
  sessions,
} from "./analysis-fixtures.js";

const strong: SpyStrength = {
  beta: 1.5,
  betaAssumed: false,
  betaReturns: 60,
  sigma: 1.2,
};

// NVDA 100 → 102.31 (+2.31%), SPY 500 → 501.55 (+0.31%) at the alert minute
// (10:29–10:30 New York).
function setup(
  options: {
    strength?: SpyStrength | null;
    close?: number;
    waitMs?: number;
  } = {},
) {
  const stored: PriceBar[] = [
    ...dayBars("NVDA", 100, [[629, options.close ?? 102.31]]),
    minuteBar("SPY", previous, 959, 500),
  ];
  const store = new MemoryDailyStore<SpyStrength>();
  if (options.strength !== null)
    store.rows.set(`${day}|NVDA`, options.strength ?? strong);
  const strength = new LiveStrength({
    multi: async () => {
      throw new Error("no daily request expected");
    },
    store,
    bars: (ticker, from) =>
      stored.filter((b) => b.ticker === ticker && b.date >= from),
    waitMs: options.waitMs,
    now: () => Date.parse(alertEnd),
  });
  return { strength, stored };
}

const spyAt = (minute: number, close: number) =>
  minuteBar("SPY", day, minute, close);
const nvdaAlert = (overrides: Partial<AlertEvent> = {}) =>
  alert({ ticker: "NVDA", close: 102.31, move: 0.8, ...overrides });

test("scenario 1: confirmed long, 65/100, in the Telegram line", async () => {
  const { strength } = setup();
  await strength.prepare(day, ["NVDA"]);
  strength.bar(spyAt(629, 501.55));
  const vsSpy = await strength.atAlert(nvdaAlert());
  // excess = 2.31 − 1.5 × 0.31 = 1.845; 50 + 10 × 1.845 / 1.2 = 65.4 → 65.
  assert.deepEqual(vsSpy, {
    score: 65,
    area: null,
    beta: 1.5,
    betaAssumed: false,
    label: "confirmed",
    spyLagged: false,
  });
  const lines = formatAlert({ ...nvdaAlert(), vsSpy }).split("\n");
  assert.equal(lines[0], "<b>NVDA</b> · big move likely");
  assert.equal(lines[1], "▲ Long · confirmed vs SPY · 65/100");
});

test("scenarios 2 and 3: against and moving-with-market labels", async () => {
  // NVDA 100 → 99.71: excess −0.755 → 50 − 6.3 = 44 (market); a weaker
  // close gives 38 (against) for an up alert.
  const against = setup({ close: 99.0 });
  await against.strength.prepare(day, ["NVDA"]);
  against.strength.bar(spyAt(629, 501.55));
  const up = await against.strength.atAlert(nvdaAlert({ close: 99.0 }));
  // excess = −1 − 0.465 = −1.465 → 50 − 12.2 = 38.
  assert.equal(up.score, 38);
  assert.equal(up.label, "against");
  assert.equal(
    formatAlert({ ...nvdaAlert(), vsSpy: up }).split("\n")[1],
    "▲ Up · against SPY · 38/100",
  );

  const market = setup({ close: 100.465 });
  await market.strength.prepare(day, ["NVDA"]);
  market.strength.bar(spyAt(629, 501.55));
  const down = await market.strength.atAlert(
    nvdaAlert({ close: 100.465, direction: "down", move: -0.6 }),
  );
  assert.equal(down.score, 50);
  assert.equal(down.label, "market");
  assert.equal(
    formatAlert({ ...nvdaAlert({ direction: "down" }), vsSpy: down }).split(
      "\n",
    )[1],
    "▼ · moving with market · 50/100",
  );
});

test("scenario 4: without σ the score is null and the alert still goes out", async () => {
  const { strength } = setup({ strength: { ...strong, sigma: null } });
  await strength.prepare(day, ["NVDA"]);
  strength.bar(spyAt(629, 501.55));
  const vsSpy = await strength.atAlert(nvdaAlert());
  assert.equal(vsSpy.score, null);
  assert.equal(vsSpy.label, "none");
  assert.equal(
    formatAlert({ ...nvdaAlert(), vsSpy }).split("\n")[1],
    "vs SPY —",
  );
  // β/σ never prepared (daily request failed): β assumed, no score.
  const missing = setup({ strength: null });
  missing.strength.bar(spyAt(629, 501.55));
  assert.deepEqual(await missing.strength.atAlert(nvdaAlert()), {
    score: null,
    area: null,
    beta: 1,
    betaAssumed: true,
    label: "none",
    spyLagged: false,
  });
});

test("scenario 4: a failed daily request is reported as missing and retried", async () => {
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

test("scenario 5: SPY's bar 1 s late is used; 5 s late → latest bar, lagged, ≤ 3 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { strength } = setup();
  await strength.prepare(day, ["NVDA"]);
  strength.bar(spyAt(628, 501.0)); // the minute before
  let done = false;
  const late = strength.atAlert(nvdaAlert()).finally(() => (done = true));
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(done, false, "still waiting for SPY's bar");
  strength.bar(spyAt(629, 501.55));
  const used = await late;
  assert.equal(used.spyLagged, false);
  assert.equal(used.score, 65);

  const second = setup();
  await second.strength.prepare(day, ["NVDA"]);
  second.strength.bar(spyAt(628, 501.0));
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
  // SPY +0.2% from the 10:28 bar: excess 2.31 − 0.3 = 2.01 → 66.75 → 67.
  assert.equal(result.score, 67);
  second.strength.bar(spyAt(629, 501.55)); // arrives at 5 s: ignored
});

test("the alert is stored and published with vsSpy attached", async () => {
  const { strength } = setup();
  await strength.prepare(day, ["NVDA"]);
  strength.bar(spyAt(629, 501.55));
  const order: string[] = [];
  const stored: AlertEvent[] = [];
  const store = {
    alert(a: AlertEvent) {
      order.push("store");
      stored.push(a);
      return stored.filter((s) => s.end === a.end).length === 1;
    },
  };
  const events = {
    publish(a: AlertEvent) {
      order.push("publish");
      assert.equal(a.vsSpy?.score, 65);
    },
  };
  await raiseScored(nvdaAlert(), strength, store, events);
  await raiseScored(nvdaAlert(), strength, store, events);
  assert.deepEqual(order, ["store", "publish", "store"]);
  assert.equal(stored[0]!.vsSpy?.label, "confirmed");
});

test("scenario 7: the analysis score equals the alert-time score for the same minute", async () => {
  const daily = pairedDaily(0.02);
  const nvdaBars = dayBars("NVDA", 100, [[629, 102]]);
  const spyBars = dayBars("SPY", 500, [[629, 497]]);
  const strength = new LiveStrength({
    multi: async (tickers) =>
      new Map(
        tickers.map((t) => [t, t === "SPY" ? daily.benchmark : daily.stock]),
      ),
    store: new MemoryDailyStore<SpyStrength>(),
    bars: (ticker, from) =>
      (ticker === "SPY" ? spyBars : nvdaBars).filter((b) => b.date >= from),
  });
  assert.equal(await strength.prepare(day, ["NVDA"]), 0);
  strength.bar(spyBars.at(-1)!);
  const event = nvdaAlert({ close: 102 });
  const live = await strength.atAlert(event);
  const analysis = scoreAgainst({
    alert: event,
    stockBars: nvdaBars,
    benchmark: "SPY",
    kind: "market",
    benchmarkBars: spyBars,
    stockDaily: daily.stock,
    benchmarkDaily: daily.benchmark,
    sessions,
    previous,
  });
  assert.ok(analysis.score !== null);
  assert.equal(live.score, analysis.score);
  assert.equal(live.beta, analysis.beta);
  assert.equal(live.betaAssumed, analysis.betaAssumed);
});

test("strength now uses each symbol's and SPY's latest bars", async () => {
  const { strength } = setup();
  await strength.prepare(day, ["NVDA"]);
  strength.bar(spyAt(629, 501.55));
  strength.bar(minuteBar("NVDA", day, 629, 102.31));
  strength.bar(minuteBar("NVDA", day, 649, 103.5));
  strength.bar(spyAt(649, 501.0));
  const now = strength.current(["NVDA", "AAPL"]);
  // +3.5% vs SPY +0.2%: excess 3.2 → 50 + 26.7 = 77.
  assert.deepEqual(now, {
    NVDA: { score: 77, at: minuteBar("NVDA", day, 649, 1).end },
  });
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
