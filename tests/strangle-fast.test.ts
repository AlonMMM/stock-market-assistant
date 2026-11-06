import { test } from "node:test";
import assert from "node:assert/strict";
import {
  carried,
  fastAlerts,
  fastState,
  paceSums,
  fastBaseline,
  FastFire,
  fastRule,
  fastWindows,
  liveFastRules,
  shockKind,
  shockRule,
  shockRuleFor,
  type FastDay,
} from "../packages/trading/src/strangle/fast.js";
import {
  burstAtSecond,
  burstOf,
} from "../packages/trading/src/strangle/decide.js";
import { FastTape, stockSeconds } from "../apps/trader/src/strangle-fast.js";
import { secondsFromTrades } from "../packages/market-data/src/volume-backtest.js";
import type { BotMarket } from "../apps/trader/src/bot.js";
import type { AlpacaTrade } from "../packages/market-data/src/alpaca.js";

/** A quiet day: 100 shares every slot at a price drifting 0.01% up and down. */
function quiet(): FastDay {
  const v = new Array(fastRule.slots).fill(100);
  const c = Array.from(
    { length: fastRule.slots },
    (_, t) => 100 * (1 + (t % 2 ? 0.0001 : 0)),
  );
  return { v, c };
}

test("60-second alert: fires on a volume and price burst, once, then waits out the cooldown", () => {
  const base = fastBaseline(
    Array.from({ length: 20 }, () => fastWindows(quiet())),
  )!;
  const day = quiet();
  // 10:00:00-10:01:00: 6 slots of 2,000 shares climbing 1%.
  const burst = (from: number) => {
    for (let k = 0; k < 6; k++) {
      day.v[from + k] = 2000;
      day.c[from + k] = 100 * (1 + 0.002 * (k + 1));
    }
    for (let t = from + 6; t < from + 30; t++) day.c[t] = 101.2;
  };
  burst(180);
  burst(240); // 10 minutes later: inside the 30-minute cooldown
  burst(600); // 70 minutes later: a new alert
  const got = fastAlerts(day, base);
  assert.deepEqual(
    got.map((a) => a.slot),
    [181, 601],
  );
  assert.equal(got[0]!.up, true);
  assert.equal(got[0]!.second, 1820);
});

test("shock (Volume 1.3.0): at 3x today's pace a burst before the pace exists, or on a day already busy, does not fire; on a quiet day it does", () => {
  const base = fastBaseline(
    Array.from({ length: 20 }, () => fastWindows(quiet())),
  )!;
  // 6 slots of 2,000 shares climbing 1.2%: 12,000 in 60 s, 20x the usual 600.
  const burst = (day: FastDay, from: number) => {
    for (let k = 0; k < 6; k++) {
      day.v[from + k] = 2000;
      day.c[from + k] = 100 * (1 + 0.002 * (k + 1));
    }
    for (let t = from + 6; t < from + 30; t++) day.c[t] = 101.2;
  };
  const slots = (day: FastDay, paceMin: number) =>
    fastAlerts(day, base, shockRuleFor(paceMin)).map((a) => a.slot);
  // 10:00 (slot 180): no pace yet (it starts 15 minutes into the 10:00 zone).
  const early = quiet();
  burst(early, 180);
  assert.deepEqual(slots(early, 0), [184]); // 15x once 5 of the 6 slots are in
  assert.deepEqual(slots(early, 3), []);
  // 11:10 on a quiet day: 20x today's pace too.
  const quietDay = quiet();
  burst(quietDay, 600);
  assert.deepEqual(slots(quietDay, 3), [604]);
  // 11:10 on a day trading 800 a slot: 20x the usual but 2.5x today's pace.
  const busy = quiet();
  busy.v.fill(800);
  burst(busy, 600);
  assert.deepEqual(slots(busy, 0), [603]);
  assert.deepEqual(slots(busy, 3), []);
  // 0 is the ungated rule, unchanged
  assert.deepEqual(shockRuleFor(0), shockRule);
  assert.equal(shockKind(0), "shock");
  assert.equal(shockKind(3), "shock_p3");
});

test("liveFastRules (Volume 1.3.0): both shock lists are kept from the open whatever the gate; shockPaceMin picks the one that trades; off, none", () => {
  const of = (s: Parameters<typeof liveFastRules>[0]) =>
    liveFastRules(s).map((r) => `${r.key}:${r.kind}:${r.trades}`);
  assert.deepEqual(
    of({ fastAlert: false, shockAlert: true, shockPaceMin: 0 }),
    ["shock:shock:true", "paced:shock_p3:false"],
  );
  assert.deepEqual(
    of({ fastAlert: false, shockAlert: true, shockPaceMin: 3 }),
    ["shock:shock:false", "paced:shock_p3:true"],
  );
  assert.deepEqual(
    of({ fastAlert: true, shockAlert: false, shockPaceMin: 3 }),
    ["fast:fast:true"],
  );
  // exactly one shock list trades, so one alert slot is one entry at most
  for (const shockPaceMin of [0, 3])
    assert.equal(
      liveFastRules({
        fastAlert: false,
        shockAlert: true,
        shockPaceMin,
      }).filter((r) => r.isShock && r.trades).length,
      1,
    );
  assert.equal(
    liveFastRules({ fastAlert: false, shockAlert: true, shockPaceMin: 0 })[1]!
      .rule.paceMin,
    3,
  );
});

test("shock (Volume 1.3.0): the gate is >= paceMin, from the first slot the pace exists", () => {
  const base = fastBaseline(
    Array.from({ length: 20 }, () => fastWindows(quiet())),
  )!;
  // Today 1,000 a slot (the usual is 100): any burst is 15x the usual, so
  // the only bar left is the gate; exactly 3x the pace is 18,000 in 60 s.
  const at = (shares: number, t: number, paceMin: number) => {
    const day = quiet();
    day.v.fill(1000);
    for (let k = t - 5; k <= t; k++) {
      day.v[k] = shares / 6;
      day.c[k] = 100 * (1 + 0.002 * (k - t + 6));
    }
    const cf = carried(day.c);
    return fastState(day, cf, base, t, paceSums(day.v), shockRuleFor(paceMin))
      .on;
  };
  assert.equal(at(18000, 700, 3), true, "exactly 3x");
  assert.equal(at(17940, 700, 3), false, "just under");
  // the pace exists once the slot before the window is paceFrom + 89
  const first = fastRule.paceFrom + 89 + fastRule.window;
  assert.equal(at(60000, first, 3), true);
  assert.equal(at(60000, first - 1, 3), false, "no pace yet");
  assert.equal(at(60000, first - 1, 0), true, "ungated");
});

test("60-second alert: no alert before 09:40 or without 20 sessions", () => {
  assert.equal(
    fastBaseline(Array.from({ length: 19 }, () => fastWindows(quiet()))),
    null,
  );
  const fire = new FastFire();
  assert.equal(fire.step(10, true), true);
  assert.equal(fire.step(11, true), false); // still above: no fresh crossing
  assert.equal(fire.step(12, false), false);
  assert.equal(fire.step(13, true), false); // inside the cooldown
  assert.equal(fire.step(10 + fastRule.cooldown, false), false);
  assert.equal(fire.step(11 + fastRule.cooldown, true), true);
});

test("60-second alert: closes before the first bar take the first close", () => {
  assert.deepEqual(carried([null, null, 5, null, 6]), [5, 5, 5, 5, 6]);
});

test("60-second alert: the burst at a second matches the minute burst at a minute's end", () => {
  const bars = Array.from({ length: 20 }, (_, m) => ({ m, c: 100 + m }));
  assert.equal(
    burstAtSecond(bars, (10 + 1) * 60, 110, 0.01),
    burstOf(bars, 10, 0.01),
  );
  // 10:41:20 (second 4280): against the close of minute 67 (10:37), (4280 - 180) // 60 - 1.
  const later = Array.from({ length: 80 }, (_, m) => ({ m, c: 100 + m }));
  assert.equal(burstAtSecond(later, 4280, 170, 0.01), (170 / 167 - 1) / 0.01);
});

test("60-second alert: the tape reads each trade once across overlapping polls", async () => {
  const open = Date.parse("2026-10-21T13:30:00Z");
  const trades: AlpacaTrade[] = [
    { t: "2026-10-21T13:30:01.000Z", x: "V", p: 10, s: 100, i: 1, z: "C" },
    { t: "2026-10-21T13:30:05.000Z", x: "V", p: 10.1, s: 200, i: 2, z: "C" },
    { t: "2026-10-21T13:30:12.000Z", x: "V", p: 10.2, s: 300, i: 3, z: "C" },
  ];
  const market = {
    async trades(
      _s: string[],
      from: number,
      to: number,
      onPage: (s: string, t: AlpacaTrade[]) => void,
    ) {
      onPage(
        "ABC",
        trades.filter((t) => Date.parse(t.t) >= from && Date.parse(t.t) <= to),
      );
    },
  } as unknown as BotMarket;
  const tape = new FastTape(["ABC"], open, open + 23_400_000);
  await tape.poll(market, open + 8_000);
  await tape.poll(market, open + 14_000);
  await tape.poll(market, open + 16_000);
  const day = tape.day("ABC");
  assert.equal(day.v[0], 300);
  assert.equal(day.c[0], 10.1);
  assert.equal(day.v[1], 300);
});

test("cross look-back (2026-11-06): the bot's seconds since the alert are the backtest's, trade for trade (odd lots and late prints left out alike)", async () => {
  const open = Date.parse("2026-11-05T14:30:00Z");
  const at = (sec: number, ms = 0) =>
    new Date(open + sec * 1000 + ms).toISOString();
  const trades: AlpacaTrade[] = [
    { t: at(5940, 100), x: "V", p: 674.4, s: 100, i: 1, z: "A" },
    { t: at(5951, 200), x: "V", p: 675.36, s: 200, i: 2, z: "A" },
    // An odd lot: not a second's last price under the bar rules.
    { t: at(5952, 100), x: "V", p: 675.8, s: 5, i: 3, z: "A", c: ["I"] },
    { t: at(5952, 300), x: "V", p: 675.375, s: 100, i: 4, z: "A" },
    { t: at(5953, 900), x: "V", p: 675.55, s: 100, i: 5, z: "A" },
  ];
  const market = {
    async trades(
      _s: string[],
      from: number,
      to: number,
      onPage: (s: string, t: AlpacaTrade[]) => void,
    ) {
      onPage(
        "MU",
        trades.filter((x) => Date.parse(x.t) >= from && Date.parse(x.t) < to),
      );
    },
  } as unknown as BotMarket;
  const bot = await stockSeconds(market, "MU", open, 5940, 5955);
  assert.deepEqual(bot, secondsFromTrades(trades, open, 5940, 5955));
  assert.deepEqual(bot.at(-2), [5952, 675.375]);
});
