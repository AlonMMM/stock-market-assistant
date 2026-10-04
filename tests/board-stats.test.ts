import { test } from "node:test";
import assert from "node:assert/strict";
import type { RawBar } from "../packages/market-data/src/bars.js";
import {
  D1StrengthStore,
  runBoard as runLiveBoard,
} from "../packages/market-data/src/board.js";
import type { SpyStrength } from "../packages/market-data/src/rs-score.js";
import type { SigmaCurve } from "../packages/market-data/src/area-vs-spy.js";
import { pairedDaily } from "./analysis-fixtures.js";
import {
  newYorkToUtc,
  previousSessions,
} from "../packages/market-data/src/calendar.js";
import {
  D1BaselineStore,
  MemoryBaselineStore,
  MemoryDailyStore,
  typicalAt,
  volumeCurve,
  type VolumeCurve,
} from "../packages/market-data/src/volume-baseline.js";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";
import { buildApp } from "../apps/api/src/app.js";
import worker from "../apps/api/src/worker.js";

// SYNTHETIC market data. Board day: Tue 2026-09-29 (EDT, 09:30 NY = 13:30Z).
const date = "2026-09-29";
const sessions = previousSessions(date, 20);
const at = (iso: string) => Date.parse(iso) / 1000;
const bar = (start: number, volume: number, low = 10, high = 10): RawBar => ({
  start,
  open: 10,
  high,
  low,
  close: 10,
  volume,
});

// Previous session i (0 = oldest) trades 100 × (i + 1) shares per regular
// 5-minute bar, plus a pre-market bar that must not count.
function history(d: string, sessionCount = 20): RawBar[] {
  const i = sessions.indexOf(d);
  if (i < 20 - sessionCount) return [];
  const rows = [bar(newYorkToUtc(d, 540) / 1000, 1_000_000)];
  for (let m = 570; m < 960; m += 5)
    rows.push(bar(newYorkToUtc(d, m) / 1000, 100 * (i + 1)));
  return rows;
}

// Today: pre-market low 9 at 08:00 NY; regular 5-minute bars of 2,100 shares
// from 09:30; the bar starting at the cutoff is incomplete (high 12).
function today(cutoff: number): RawBar[] {
  const rows = [bar(at(`${date}T12:00:00Z`), 50_000, 9, 10)];
  for (let s = at(`${date}T13:30:00Z`); s < cutoff; s += 300)
    rows.push(bar(s, 2100));
  rows.push(bar(cutoff, 999_999, 10, 12));
  return rows;
}

// These fixtures were built for the free plan's 15-minute SIP delay.
const runBoard = (
  ...[tickers, multi, now, benchmarks, store, strengths, , area]: Parameters<
    typeof runLiveBoard
  >
) => runLiveBoard(tickers, multi, now, benchmarks, store, strengths, 15, area);

type Multi = Parameters<typeof runBoard>[1];

function fake(cutoff: number, counts: Record<string, number> = {}) {
  const calls: string[][] = [];
  const multi = async (
    symbols: string[],
    start: string,
    end: string,
    timeframe: "1Min" | "5Min" | "1Day",
  ) => {
    calls.push([symbols.join(), start, end, timeframe]);
    const day = new Date(Date.parse(start) - 4 * 3600000)
      .toISOString()
      .slice(0, 10);
    return new Map(
      symbols.map((s) => [
        s,
        timeframe === "1Day"
          ? [bar(at("2026-09-28T04:00:00Z"), 1)]
          : start.startsWith(`${date}T00`)
            ? today(cutoff)
            : history(day, counts[s]),
      ]),
    );
  };
  return { calls, multi };
}

test("normal case: volume to the cutoff vs the median of 20 sessions", async () => {
  // 11:00 NY; data cutoff 10:45 NY (14:45Z): fifteen complete regular bars.
  const now = at(`${date}T15:00:00Z`) * 1000;
  const { multi } = fake(at(`${date}T14:45:00Z`));
  const board = await runBoard(["NVDA"], multi, now);
  const nvda = board.series.find((s) => s.ticker === "NVDA")!;
  assert.deepEqual(nvda.stats, {
    asOf: at(`${date}T14:45:00Z`),
    dayLow: 9, // pre-market included
    dayHigh: 12, // the incomplete bar's high counts toward the range
    volume: 15 * 2100,
    typicalVolume: 15 * 100 * 10.5, // median of 1..20 is 10.5
    relVolume: 2,
    // One daily bar of history: β cannot be estimated and σ is unavailable.
    rsScore: null,
    beta: null,
  });
  // Benchmarks not in the watchlist carry no stats.
  assert.equal(board.series.find((s) => s.ticker === "SPY")!.stats, undefined);
  assert.equal(board.series.find((s) => s.ticker === "QQQ")!.stats, undefined);
});

test("scenario 8: before the regular open Rel vol is null", async () => {
  // 09:40 NY; cutoff 09:25 NY: only pre-market data.
  const now = at(`${date}T13:40:00Z`) * 1000;
  const { multi } = fake(at(`${date}T13:25:00Z`));
  const board = await runBoard(["NVDA"], multi, now);
  assert.deepEqual(board.series[0]!.stats, {
    asOf: at(`${date}T13:25:00Z`),
    dayLow: 9,
    dayHigh: 12,
    volume: 0,
    typicalVolume: null,
    relVolume: null,
    rsScore: null,
    beta: null,
  });
  // First complete regular bar: 09:30–09:35 NY.
  const first = fake(at(`${date}T13:35:00Z`));
  const opened = await runBoard(
    ["NVDA"],
    first.multi,
    at(`${date}T13:50:00Z`) * 1000,
  );
  assert.equal(opened.series[0]!.stats!.volume, 2100);
  assert.equal(opened.series[0]!.stats!.typicalVolume, 1050);
  assert.equal(opened.series[0]!.stats!.relVolume, 2);
});

test("scenario 9: 10 of 20 prior sessions leaves Rel vol null; 15 is enough", async () => {
  const now = at(`${date}T15:00:00Z`) * 1000;
  const { multi } = fake(at(`${date}T14:45:00Z`), { THIN: 10, OK: 15 });
  const board = await runBoard(["THIN", "OK"], multi, now);
  const thin = board.series.find((s) => s.ticker === "THIN")!.stats!;
  assert.equal(thin.volume, 15 * 2100);
  assert.equal(thin.typicalVolume, null);
  assert.equal(thin.relVolume, null);
  // Sessions 6..20 (volumes 600..2000 per bar): median 13 × 100 × 15.
  const ok = board.series.find((s) => s.ticker === "OK")!.stats!;
  assert.equal(ok.typicalVolume, 19_500);
});

test("after the close, volume and typical volume cover the whole regular session", async () => {
  // 18:00 NY; the cutoff is 17:45 NY, after the 16:00 close.
  const now = at(`${date}T22:00:00Z`) * 1000;
  const { multi } = fake(at(`${date}T21:45:00Z`));
  const stats = (await runBoard(["NVDA"], multi, now)).series[0]!.stats!;
  assert.equal(stats.volume, 78 * 2100);
  assert.equal(stats.typicalVolume, 78 * 100 * 10.5);
});

test("stored baselines make later polls skip the history requests", async () => {
  const now = at(`${date}T15:00:00Z`) * 1000;
  const store = new MemoryBaselineStore();
  const strengths = new MemoryDailyStore<SpyStrength>();
  // SYNTHETIC daily history so β/σ vs SPY are computed and stored.
  const daily = pairedDaily(0.02, previousSessions(date, 61));
  let splitCalls = 0;
  const withDaily =
    (base: Multi): Multi =>
    async (symbols, start, end, timeframe, adjustment) => {
      if (adjustment !== "split") return base(symbols, start, end, timeframe);
      splitCalls++;
      return new Map(
        symbols.map((s) => [s, s === "SPY" ? daily.benchmark : daily.stock]),
      );
    };
  const first = fake(at(`${date}T14:45:00Z`));
  await runBoard(["NVDA"], withDaily(first.multi), now, {}, store, strengths);
  // intraday, daily, 20 sessions; plus one β/σ history request
  assert.equal(first.calls.length, 22);
  assert.equal(splitCalls, 1);
  assert.equal(strengths.rows.size, 1);
  const second = fake(at(`${date}T14:45:00Z`));
  const board = await runBoard(
    ["NVDA"],
    second.multi,
    now,
    {},
    store,
    strengths,
  );
  assert.equal(second.calls.length, 2);
  assert.equal(splitCalls, 1);
  assert.equal(board.series[0]!.stats!.relVolume, 2);
  assert.ok(Math.abs(board.series[0]!.stats!.beta! - 1.5) < 1e-9);
});

test("a failed history request still returns the board without Rel vol", async () => {
  const now = at(`${date}T15:00:00Z`) * 1000;
  const { multi } = fake(at(`${date}T14:45:00Z`));
  const store = new MemoryBaselineStore();
  const board = await runBoard(
    ["NVDA"],
    async (symbols, start, end, timeframe) => {
      if (timeframe === "5Min" && !start.startsWith(`${date}T00`))
        throw new Error("Alpaca REST request failed (429)");
      return multi(symbols, start, end, timeframe);
    },
    now,
    {},
    store,
  );
  const stats = board.series[0]!.stats!;
  assert.equal(stats.volume, 15 * 2100);
  assert.equal(stats.relVolume, null);
  assert.equal(store.rows.size, 0); // failures are not stored
});

test("early-close sessions only count up to their 13:00 close", () => {
  // Sessions before Tue 2026-12-01 include Fri 2026-11-27 (closes 13:00 NY).
  const list = previousSessions("2026-12-01", 20);
  assert.ok(list.includes("2026-11-27"));
  const rows = list.flatMap((d) => {
    const close = d === "2026-11-27" ? 780 : 960;
    const out: RawBar[] = [];
    for (let m = 570; m < close; m += 5)
      out.push(bar(newYorkToUtc(d, m) / 1000, 1));
    return out;
  });
  const curve = volumeCurve(rows, list);
  assert.equal(typicalAt(curve, 780), 42);
  assert.equal(typicalAt(curve, 960), 78); // 19 full sessions
  assert.equal(typicalAt(curve, 962), null); // not a 5-minute mark
});

test("the D1 baseline store round-trips with one query per read", async () => {
  const sqlite = new SqliteD1(":memory:");
  const store = new D1BaselineStore(sqlite);
  const curves = new Map<string, VolumeCurve>(
    Array.from({ length: 45 }, (_, i) => [`T${i}`, [i, null]]),
  );
  await store.put("2026-09-28", new Map([["OLD", [1]]]));
  await store.put(date, curves);
  const got = await store.get(date, ["T0", "T44", "MISSING"]);
  assert.deepEqual(Object.fromEntries(got), { T0: [0, null], T44: [44, null] });
  // Older board dates are dropped on write.
  assert.equal((await store.get("2026-09-28", ["OLD"])).size, 0);
  sqlite.close();
});

test("local API and hosted Worker share the board contract", async () => {
  const unconfigured = buildApp(false, {});
  try {
    const local = await unconfigured.inject({
      method: "GET",
      url: "/api/board",
    });
    const hosted = await worker.fetch(
      new Request("https://example.test/api/board"),
    );
    assert.equal(hosted.status, 503);
    assert.equal(local.statusCode, 503);
    assert.deepEqual(await hosted.json(), local.json());
  } finally {
    await unconfigured.close();
  }
});

const priced = (start: number, close: number): RawBar => ({
  ...bar(start, 1, close, close),
  open: close,
  close,
});

// SYNTHETIC: NVDA 100 → 102 (+2%) and SPY 500 → 497 (−0.6%) at the newest
// complete 5-minute bar; daily history gives β 1.5 and ±2% daily excess.
function strengthBoard(failDaily = false) {
  const daily = pairedDaily(0.02, previousSessions(date, 61));
  const calls: string[] = [];
  const multi: Multi = async (symbols, start, end, timeframe, adjustment) => {
    calls.push(`${timeframe}${adjustment ? `:${adjustment}` : ""}`);
    if (adjustment === "split") {
      if (failDaily) throw new Error("Alpaca REST request failed (429)");
      return new Map(
        symbols.map((s) => [s, s === "SPY" ? daily.benchmark : daily.stock]),
      );
    }
    const base: Record<string, number> = { NVDA: 100, SPY: 500, QQQ: 400 };
    return new Map(
      symbols.map((s) => {
        if (timeframe === "1Day")
          return [s, [priced(at("2026-09-28T04:00:00Z"), base[s]!)]];
        if (!start.startsWith(`${date}T00`)) return [s, []];
        const [done, partial] =
          s === "NVDA" ? [102, 150] : s === "SPY" ? [497, 600] : [400, 400];
        return [
          s,
          [
            priced(at(`${date}T14:40:00Z`), done!),
            // Starts at asOf: incomplete, not used for the score.
            priced(at(`${date}T14:45:00Z`), partial!),
          ],
        ];
      }),
    );
  };
  return { calls, multi };
}

// Minute bars for the area score: NVDA opens 100 at 09:30 and closes 101
// (+1%) every minute, SPY flat at 500. Past sessions: NVDA +1% / −1% on
// alternate days, so σ = 1 at every minute.
const minutes = (ticker: string, d: string, level: number, to = 960) =>
  Array.from({ length: to - 570 }, (_, i) => ({
    start: newYorkToUtc(d, 570 + i) / 1000,
    open: i ? level : ticker === "SPY" ? 500 : 100,
    high: Math.max(level, 100),
    low: Math.min(level, 100),
    close: level,
    volume: 1,
  }));
function areaHistory() {
  const calls: string[] = [];
  const history = async (ticker: string, start: string, end: string) => {
    calls.push(ticker);
    assert.equal(end, new Date(newYorkToUtc(date, 0)).toISOString());
    assert.equal(start, new Date(newYorkToUtc(sessions[0]!, 0)).toISOString());
    return sessions.flatMap((d, i) =>
      ticker === "SPY"
        ? minutes("SPY", d, 500)
        : minutes(ticker, d, i % 2 ? 99 : 101),
    );
  };
  return { calls, history };
}

test("board stats carry the area score and β vs SPY at asOf", async () => {
  const now = at(`${date}T15:00:00Z`) * 1000;
  const { multi: base } = strengthBoard();
  const requested: string[][] = [];
  const multi: Multi = async (symbols, start, end, timeframe, adjustment) => {
    if (timeframe !== "1Min")
      return base(symbols, start, end, timeframe, adjustment);
    requested.push([symbols.join(), start, end]);
    return new Map(
      symbols.map((s) => [
        s,
        // Through 10:45 NY: the bar starting at asOf must be ignored.
        minutes(s, date, s === "SPY" ? 500 : 101, 646).map((r, i, all) =>
          i === all.length - 1 ? { ...r, close: 50, low: 50 } : r,
        ),
      ]),
    );
  };
  const sigmas = new MemoryDailyStore<SigmaCurve>();
  const baselineStore = new MemoryBaselineStore();
  const strengthStore = new MemoryDailyStore<SpyStrength>();
  const poll = (
    tickers: string[],
    history: ReturnType<typeof areaHistory>["history"],
    store = sigmas,
    perPoll?: number,
    at = now,
  ) =>
    runBoard(tickers, multi, at, {}, baselineStore, strengthStore, undefined, {
      history,
      store,
      perPoll,
    });
  // The first poll of the date fetches Rel vol and β history: no σ work.
  const cold = areaHistory();
  const firstBoard = await poll(["NVDA", "AMD"], cold.history);
  assert.equal(firstBoard.series[0]!.stats!.rsScore, null);
  assert.deepEqual(cold.calls, []);
  requested.length = 0;
  const first = areaHistory();
  const board = await poll(["NVDA"], first.history);
  const stats = board.series[0]!.stats!;
  assert.equal(stats.asOf, at(`${date}T14:45:00Z`));
  assert.ok(Math.abs(stats.beta! - 1.5) < 1e-9);
  // Area 1 (SPY flat, so β does not matter), σ 1 → round(100 · Φ(1)).
  assert.equal(stats.rsScore, 84);
  // One minute request from 09:30 NY to asOf; σ from 20 sessions, stored.
  assert.deepEqual(requested, [
    ["NVDA,SPY", `${date}T13:30:00.000Z`, `${date}T14:45:00.000Z`],
  ]);
  assert.deepEqual(first.calls, ["SPY", "NVDA"]);
  assert.equal(sigmas.rows.size, 1);
  // A later poll reads the stored curve: no history.
  const second = areaHistory();
  const again = await poll(["NVDA"], second.history);
  assert.equal(again.series[0]!.stats!.rsScore, 84);
  assert.deepEqual(second.calls, []);
  // At most `perPoll` curves per poll, in a rotating order; the rest stay
  // null until a later poll.
  const fresh = new MemoryDailyStore<SigmaCurve>();
  const one = await poll(["NVDA", "AMD"], areaHistory().history, fresh, 1);
  const scores = one.series.slice(0, 2).map((x) => x.stats!.rsScore);
  assert.deepEqual([...scores].sort(), [84, null]);
  const next = await poll(
    ["NVDA", "AMD"],
    areaHistory().history,
    fresh,
    1,
    now + 60000,
  );
  assert.deepEqual(
    next.series.slice(0, 2).map((x) => x.stats!.rsScore),
    [84, 84],
  );
});

test("a failed β/σ history request leaves score and β null, not stored", async () => {
  const now = at(`${date}T15:00:00Z`) * 1000;
  const { multi } = strengthBoard(true);
  const strengths = new MemoryDailyStore<SpyStrength>();
  const board = await runBoard(["NVDA"], multi, now, {}, undefined, strengths);
  const stats = board.series[0]!.stats!;
  assert.equal(stats.rsScore, null);
  assert.equal(stats.beta, null);
  assert.equal(stats.volume, 1); // the rest of the board is unaffected
  assert.equal(strengths.rows.size, 0);
});

test("the D1 strength store round-trips β/σ per board date", async () => {
  const sqlite = new SqliteD1(":memory:");
  const store = new D1StrengthStore(sqlite);
  const value: SpyStrength = {
    beta: 1.2,
    betaAssumed: false,
    betaReturns: 60,
    sigma: null,
  };
  await store.put("2026-09-28", new Map([["OLD", value]]));
  await store.put(date, new Map([["NVDA", value]]));
  assert.deepEqual(Object.fromEntries(await store.get(date, ["NVDA", "X"])), {
    NVDA: value,
  });
  assert.equal((await store.get("2026-09-28", ["OLD"])).size, 0);
  // The Rel vol baselines share the database but not the table.
  assert.equal((await new D1BaselineStore(sqlite).get(date, ["NVDA"])).size, 0);
  sqlite.close();
});
