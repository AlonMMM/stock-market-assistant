import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lookNow,
  LookNowScorer,
  lookNowWeights,
  RandomMinutes,
  ranks,
  summarizeLookNow,
  type LookNowHorizon,
  type Ranks,
} from "../packages/market-data/src/look-now.js";
import { normalize, type PriceBar } from "../packages/market-data/src/bars.js";
import {
  newYorkToUtc,
  previousSessions,
} from "../packages/market-data/src/calendar.js";

// SYNTHETIC minute bars. `price(m)` gives the close at New York start minute m.
function session(
  ticker: string,
  date: string,
  price: (m: number) => number,
  from = 570,
  to = 959,
  skip: (m: number) => boolean = () => false,
): PriceBar[] {
  const bars: PriceBar[] = [];
  let previous = price(from);
  for (let m = from; m <= to; m++) {
    if (skip(m)) continue;
    const close = price(m);
    const bar = normalize(
      ticker,
      {
        start: newYorkToUtc(date, m) / 1000,
        open: previous,
        high: Math.max(previous, close),
        low: Math.min(previous, close),
        close,
        volume: 1000,
      },
      "shares",
    );
    if (bar) bars.push(bar);
    previous = close;
  }
  return bars;
}
const wiggle = (m: number) => 100 * (1 + 0.001 * Math.sin(m / 3));
const day = "2026-09-28";
const history = previousSessions(day, 20);
const quietDays = (ticker = "AAPL") =>
  history.flatMap((d) => session(ticker, d, wiggle));
// Every horizon ranks against the same synthetic distribution: z = 0..9.9.
const flatRanks: Ranks = new Map(
  ([5, 15, 30, 60, "close"] as LookNowHorizon[]).map((h) => [
    h,
    Float64Array.from({ length: 100 }, (_, i) => i / 10),
  ]),
);
const none = () => null;

test("scores a jump after the alert against the stock's normal moves", () => {
  // Today: quiet until 11:00 (minute 660), then +3% over ten minutes.
  const jump = (m: number) =>
    wiggle(m) * (1 + 0.003 * Math.min(10, Math.max(0, m - 660)));
  const scorer = new LookNowScorer(
    [...quietDays(), ...session("AAPL", day, jump)],
    null,
    none,
  );
  // Alert bar ends 11:00 (end-minute 660); entry is the 11:01 bar's open.
  const measured = scorer.measure(day, 660, "regular");
  assert.ok(measured.ok);
  assert.deepEqual(
    measured.moves.map((m) => m.horizon),
    [5, 15, 30, 60, "close"],
  );
  for (const m of measured.moves) {
    assert.ok(m.move > 0);
    assert.ok(m.z > 3, `${m.horizon}: z ${m.z}`);
    assert.equal(m.marketAdjusted, false); // no SPY bars given
  }
  const score = lookNow(
    measured,
    "up",
    flatRanks,
    { beta: 1, assumed: true },
    960,
    660,
  );
  assert.ok(score.score! > 30);
  assert.equal(score.withBurst, true);
  assert.equal(score.nearClose, false);
  assert.equal(
    lookNow(measured, "down", flatRanks, null, 960, 660).withBurst,
    false,
  );
});

test("weights favour short horizons and re-normalize near the close", () => {
  const scorer = new LookNowScorer(
    [...quietDays(), ...session("AAPL", day, wiggle)],
    null,
    none,
  );
  // 25 minutes before the 16:00 close (end-minute 935): 30m and 60m drop out.
  const late = scorer.measure(day, 935, "regular");
  assert.ok(late.ok);
  assert.deepEqual(
    late.moves.map((m) => m.horizon),
    [5, 15, "close"],
  );
  const ranked: Ranks = new Map<LookNowHorizon, Float64Array>([
    [5, Float64Array.from([0, 0, 0, 1e9])], // percentile 75 for any small z
    [15, Float64Array.from([1e9, 1e9, 1e9, 1e9])], // percentile 0
    ["close", Float64Array.from([0, 0, 0, 0])], // percentile 100
  ]);
  const s = lookNow(late, "up", ranked, null, 960, 935);
  const w = lookNowWeights;
  const expected =
    (w[5] * 75 + w[15] * 0 + w.close * 100) / (w[5] + w[15] + w.close);
  assert.ok(Math.abs(s.score! - expected) < 1e-9);
  assert.equal(s.nearClose, true);
  // Under 5 minutes left: only the close horizon.
  const last = scorer.measure(day, 957, "regular");
  assert.ok(last.ok);
  assert.deepEqual(
    last.moves.map((m) => m.horizon),
    ["close"],
  );
  // The last regular minute has no time left.
  assert.deepEqual(scorer.measure(day, 960, "regular"), {
    ok: false,
    reason: "No time left in the session",
  });
});

test("uses the real close on early-close days", () => {
  // 2026-11-27 closes at 13:00 (end-minute 780).
  const early = "2026-11-27";
  const past = previousSessions(early, 20).flatMap((d) =>
    session("AAPL", d, wiggle),
  );
  const scorer = new LookNowScorer(
    [...past, ...session("AAPL", early, wiggle, 570, 779)],
    null,
    none,
  );
  const m = scorer.measure(early, 740, "regular");
  assert.ok(m.ok);
  // 12:20: 60 minutes would pass the 13:00 close.
  assert.deepEqual(
    m.moves.map((x) => x.horizon),
    [5, 15, 30, "close"],
  );
});

test("unscored outside regular hours, without a trade after, or without history", () => {
  const scorer = new LookNowScorer(
    [
      ...quietDays(),
      ...session("AAPL", day, wiggle, 570, 959, (m) => m >= 661 && m <= 663),
    ],
    null,
    none,
  );
  assert.deepEqual(scorer.measure(day, 540, "pre"), {
    ok: false,
    reason: "Outside regular hours",
  });
  // No bar in the 3 minutes after the 11:00 alert.
  assert.deepEqual(scorer.measure(day, 661, "regular"), {
    ok: false,
    reason: "No trade after the alert",
  });
  // A bar two minutes later is the entry.
  assert.ok(scorer.measure(day, 662, "regular").ok);
  const young = new LookNowScorer(session("AAPL", day, wiggle), null, none);
  assert.deepEqual(young.measure(day, 660, "regular"), {
    ok: false,
    reason: "Not enough history",
  });
  const s = lookNow(
    young.measure(day, 660, "regular"),
    "up",
    flatRanks,
    null,
    960,
    660,
  );
  assert.equal(s.score, null);
  assert.equal(s.reason, "Not enough history");
});

test("missing minutes inside a horizon use the bars that exist", () => {
  // Only every 4th minute trades after 11:00.
  const sparse = (m: number) => m > 660 && m % 4 !== 0;
  const scorer = new LookNowScorer(
    [...quietDays(), ...session("AAPL", day, wiggle, 570, 959, sparse)],
    null,
    none,
  );
  const m = scorer.measure(day, 659, "regular");
  assert.ok(m.ok);
  assert.ok(m.moves.some((x) => x.horizon === 5));
});

test("removes the market's part with β, and flags raw moves", () => {
  // SPY and the stock both rise 1% over ten minutes after 11:00; β = 1.
  const rise = (m: number) =>
    m < 661 ? wiggle(m) : wiggle(660) * (1 + 0.001 * Math.min(10, m - 660));
  const spy = [
    ...history.flatMap((d) => session("SPY", d, wiggle)),
    ...session("SPY", day, rise),
  ];
  const stock = [
    // The stock's own normal wiggle, so its market-adjusted normal move is not 0.
    ...history.flatMap((d) =>
      session("AAPL", d, (m) => 100 * (1 + 0.002 * Math.sin(m / 5))),
    ),
    ...session("AAPL", day, rise),
  ];
  const adjusted = new LookNowScorer(stock, spy, () => 1).measure(
    day,
    660,
    "regular",
  );
  const raw = new LookNowScorer(stock, null, () => 1).measure(
    day,
    660,
    "regular",
  );
  assert.ok(adjusted.ok && raw.ok);
  const at = (x: typeof adjusted, h: LookNowHorizon) =>
    x.ok ? x.moves.find((m) => m.horizon === h)! : null;
  assert.ok(Math.abs(at(raw, 15)!.move) > 0.9);
  assert.ok(Math.abs(at(adjusted, 15)!.move) < 0.05);
  assert.equal(at(adjusted, 15)!.marketAdjusted, true);
  assert.equal(at(raw, 15)!.marketAdjusted, false);
  // The SPY ticker itself (β 0) is never adjusted.
  const self = new LookNowScorer(spy, spy, () => 0).measure(
    day,
    660,
    "regular",
  );
  assert.ok(self.ok && self.moves.every((m) => !m.marketAdjusted));
});

test("ranks, labels and summary against random minutes", () => {
  const jump = (m: number) =>
    wiggle(m) * (1 + 0.003 * Math.min(10, Math.max(0, m - 660)));
  const scorer = new LookNowScorer(
    [...quietDays(), ...session("AAPL", day, jump)],
    null,
    none,
  );
  const randoms = scorer.baseline(day, day);
  assert.ok(randoms.length > 50);
  const rank = ranks(randoms.map((r) => r.measured));
  const alert = lookNow(
    scorer.measure(day, 660, "regular"),
    "up",
    rank,
    null,
    960,
    660,
  );
  assert.ok(alert.score! >= 90, `score ${alert.score}`);
  assert.ok(alert.label === "big" || alert.label === "very-big");
  const randomScores = randoms.map((r) =>
    lookNow(r.measured, r.direction, rank, null, null, null),
  );
  const summary = summarizeLookNow(
    [
      alert,
      lookNow(
        { ok: false, reason: "Outside regular hours" },
        "up",
        rank,
        null,
        null,
        null,
      ),
    ],
    randomScores,
  );
  assert.equal(summary.scored, 1);
  assert.equal(summary.unscored, 1);
  assert.deepEqual(summary.reasons, { "Outside regular hours": 1 });
  assert.equal(summary.big, 1);
  assert.ok(summary.baseline.averageScore! < alert.score!);
  // Too few random minutes for a horizon: it is left unranked.
  assert.equal(ranks(randoms.slice(0, 5).map((r) => r.measured)).size, 0);
  // The compact store used by long runs ranks and scores identically.
  const compact = new RandomMinutes();
  for (const r of randoms) compact.add(r.measured);
  compact.add({ ok: false, reason: "Outside regular hours" });
  assert.deepEqual(compact.ranks(), rank);
  assert.deepEqual(
    compact.scores(rank).map((r) => r.score),
    randomScores.map((r) => r.score),
  );
});
