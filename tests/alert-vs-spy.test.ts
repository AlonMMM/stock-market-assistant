// SYNTHETIC market data: marked-sections score vs SPY at alert time and now
// in the collector (docs/features/marks-vs-spy.md; SPY wait from
// alert-vs-spy.md).
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
  byDate,
  dayMarks,
  daySeries,
  fromPriceBar,
  marksScore,
  marksSeries,
  type MarksSigma,
} from "../packages/market-data/src/marks-vs-spy.js";
import {
  marksAlertEnd,
  marksScoreAt,
} from "../packages/contracts/src/vs-spy.js";
import type { SpyStrength } from "../packages/market-data/src/rs-score.js";
import { MemoryDailyStore } from "../packages/market-data/src/volume-baseline.js";
import {
  newYorkToUtc,
  previousSessions,
} from "../packages/market-data/src/calendar.js";
import { alert, alertEnd, day, previous } from "./analysis-fixtures.js";

const unit: SpyStrength = {
  beta: 1,
  betaAssumed: false,
  betaReturns: 60,
  sigma: 1.2,
};
const sigma = (value: number): MarksSigma => new Array(390).fill(value);

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

// NVDA flat at 100 (previous close 100); SPY flat at 500 except a one-
// minute dip to 497.5 (−0.5 %) at 10:20 (minute 620): a green mark with
// c = 0.5 (β 1). The alert bar is 10:29–10:30 (start minute 629), window 3,
// so E = 10:26 (626): w = 54/60, I = 0.45; σ 0.45 → round(100·Φ(1)) = 84.
const spyClose = (t: number) => (t === 620 ? 497.5 : 500);
function setup(
  options: {
    strength?: SpyStrength | null;
    sigma?: MarksSigma | null;
    spyTo?: number;
    waitMs?: number;
  } = {},
) {
  const stored: PriceBar[] = [
    bar("NVDA", previous, 959, 100),
    bar("SPY", previous, 959, 500),
    ...run("NVDA", 570, 629, () => 100, 100),
    ...run("SPY", 570, options.spyTo ?? 629, spyClose, 500),
  ];
  const strengths = new MemoryDailyStore<SpyStrength>();
  if (options.strength !== null)
    strengths.rows.set(`${day}|NVDA`, options.strength ?? unit);
  const sigmas = new MemoryDailyStore<MarksSigma>();
  if (options.sigma !== null)
    sigmas.rows.set(`${day}|NVDA`, options.sigma ?? sigma(0.45));
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
  alert({ ticker: "NVDA", close: 100, move: 0.8, ...overrides });

async function ready(s: LiveStrength) {
  await s.prepare(day, ["NVDA"]);
  await s.prepareSigma(day, ["NVDA"]);
}

test("alert score at E = alert − window: green mark, σ 0.45 → 84, one Telegram line", async () => {
  const { strength, stored } = setup();
  await ready(strength);
  strength.bar(stored.at(-1)!); // SPY's 10:29 bar
  const vsSpy = await strength.atAlert(nvdaAlert());
  assert.deepEqual(vsSpy, {
    score: 84,
    sum: 0.45,
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
  const days = (t: string) =>
    byDate(stored.filter((b) => b.ticker === t).map(fromPriceBar));
  const chart = marksSeries(
    "NVDA",
    dayMarks(
      daySeries("NVDA", days("NVDA"), day),
      daySeries("SPY", days("SPY"), day),
      day,
    ),
    1,
    false,
    sigma(0.45),
  );
  assert.equal(marksScoreAt(chart, marksAlertEnd(alertEnd, 3)), live.score);
  assert.equal(live.score, 84);
});

test("without σ the score is null and the alert still goes out", async () => {
  const { strength, stored } = setup({ sigma: null });
  await strength.prepare(day, ["NVDA"]);
  strength.bar(stored.at(-1)!);
  const vsSpy = await strength.atAlert(nvdaAlert());
  assert.equal(vsSpy.score, null);
  assert.equal(vsSpy.sum, 0.45);
  assert.equal(
    formatAlert({ ...nvdaAlert(), vsSpy }).split("\n")[1],
    "vs SPY —",
  );
  // β never prepared (daily request failed): no σ curve is computed (it
  // must use the date's β); β 1 assumed, sum still reported.
  const missing = setup({ strength: null, sigma: null });
  assert.equal(await missing.strength.prepareSigma(day, ["NVDA"]), 1);
  missing.strength.bar(missing.stored.at(-1)!);
  assert.deepEqual(await missing.strength.atAlert(nvdaAlert()), {
    score: null,
    sum: 0.45,
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

test("SPY's bar of E 1 s late is used; 5 s late → carried forward, lagged, ≤ 3 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = setup({ spyTo: 625 });
  await ready(first.strength);
  first.strength.bar(first.stored.at(-1)!); // SPY's 10:25 bar
  let done = false;
  const late = first.strength.atAlert(nvdaAlert()).finally(() => (done = true));
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(done, false, "still waiting for SPY's bar");
  const spy626 = bar("SPY", day, 626, 500); // E's bar
  first.stored.push(spy626);
  first.strength.bar(spy626);
  const used = await late;
  assert.equal(used.spyLagged, false);
  assert.equal(used.score, 84);

  const second = setup({ spyTo: 625 });
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
  assert.equal(result.score, 84); // SPY's 10:25 close carried forward
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

test("strength now is the score with E = each symbol's latest bar", async () => {
  const { strength, stored } = setup();
  await ready(strength);
  // NVDA's latest bar is 10:49 (E = 649, the mark at 620 has age 29); SPY's
  // later bars are ignored.
  for (let t = 630; t <= 649; t++) {
    const b = bar("NVDA", day, t, 100);
    stored.push(b);
    strength.bar(b);
  }
  stored.push(...run("SPY", 630, 655, () => 500, 500));
  const now = strength.current(["NVDA", "AAPL"]);
  assert.deepEqual(now, {
    NVDA: {
      score: marksScore((0.5 * 31) / 60, 0.45),
      at: bar("NVDA", day, 649, 1).end,
    },
  });
  // After the regular close the latest bar is outside the session: null.
  const post = bar("NVDA", day, 965, 100);
  stored.push(post);
  strength.bar(post);
  assert.equal(strength.current(["NVDA"]).NVDA!.score, null);
});

test("σ curves come from 20 stored sessions, are stored, and need 15", async () => {
  const prior = previousSessions(day, 20);
  // NVDA flat; SPY dips −0.5 % at 10:20 on every other session (a green
  // mark, c = 0.5 with β 1).
  const history = (dates: string[]) =>
    dates.flatMap((date, i) => [
      ...run("NVDA", 570, 700, () => 100, 100, date),
      ...run("SPY", 570, 700, i % 2 ? () => 500 : spyClose, 500, date),
    ]);
  const make = (stored: PriceBar[]) => {
    const sigmas = new MemoryDailyStore<MarksSigma>();
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
  // At 10:50 (age 30, w 1/2): I = 0.25 on 10 sessions, 0 on 10 → 0.25/√2.
  assert.ok(Math.abs(curve[650 - 570]! - 0.25 / Math.SQRT2) < 1e-3);
  // Before any mark (and long after it) every I is 0: σ 0 → null.
  assert.equal(curve[610 - 570], null);
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
  assert.equal(sparse.s.sigma(day, "NVDA")![80], null);
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
