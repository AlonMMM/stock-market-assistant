import { test } from "node:test";
import assert from "node:assert/strict";
import {
  carried,
  fastAlerts,
  fastBaseline,
  FastFire,
  fastRule,
  fastWindows,
  type FastDay,
} from "../packages/trading/src/strangle/fast.js";
import {
  burstAtSecond,
  burstOf,
} from "../packages/trading/src/strangle/decide.js";
import { FastTape } from "../apps/trader/src/strangle-fast.js";
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
