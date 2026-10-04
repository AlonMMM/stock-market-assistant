import type { PriceBar } from "./bars.js";

// Look-now score (user-confirmed 2026-10-03): after an alert, did the stock
// move much more than is normal for itself, quickly, apart from the market?
//
// Entry is the open of the first regular bar within 3 minutes after the alert.
// For each horizon h the move is the largest market-adjusted move from entry
// within h, kept with its sign: ln(stock) − β·ln(SPY), from entry (log prices,
// so the path is a difference and its peak is a window max/min; reported as a
// percentage). σ_h is the median |peak| from the same alert minute over the
// stock's previous 20 sessions. z_h = |move| ÷ σ_h, ranked against random
// minutes (every 5th regular minute of the same run, scored the same way) as a
// percentile. The score is the weighted average percentile; horizons that end
// after the regular close, have no bars, or lack history are dropped and the
// weights re-normalized.
export const lookNowHorizons = [5, 15, 30, 60, "close"] as const;
export type LookNowHorizon = (typeof lookNowHorizons)[number];
export const lookNowWeights: Record<LookNowHorizon, number> = {
  5: 0.35,
  15: 0.25,
  30: 0.2,
  60: 0.12,
  close: 0.08,
};
export const bigScore = 90;
export const veryBigScore = 97;
const sigmaSessions = 20;
const minSigmaSamples = 10;
const entryWithin = 3; // minutes after the alert to find an entry bar
const minBaseline = 30; // random-minute samples a horizon needs for ranks

export interface HorizonMove {
  horizon: LookNowHorizon;
  move: number; // percent, signed peak market-adjusted move from entry
  sigma: number; // percent, the stock's normal |peak| here
  z: number;
  percentile: number | null; // filled once ranked against random minutes
  marketAdjusted: boolean;
}

export type LookNowLabel = "very-big" | "big" | "normal";

export interface LookNow {
  score: number | null; // 0–100
  label: LookNowLabel | null;
  reason?: string; // why unscored
  horizons: HorizonMove[];
  peak: LookNowHorizon | null; // horizon with the highest percentile
  withBurst: boolean | null; // the peak move's direction vs the alert's
  nearClose: boolean; // fewer than 60 minutes left in the session
  beta: number | null;
  betaAssumed: boolean;
}

interface Day {
  close: number; // regular close end-minute
  opens: Float64Array; // by end-minute, regular session only; NaN = no bar
  closes: Float64Array;
  spy: Float64Array | null; // SPY close at or before each minute
}

type Measured =
  | { ok: true; entry: number; moves: Omit<HorizonMove, "percentile">[] }
  | { ok: false; reason: string };

/** One symbol's bars (plus SPY's) for look-now measurement. */
export class LookNowScorer {
  private days = new Map<string, Day>();
  private dates: string[] = [];
  private peakCache = new Map<
    string,
    { move: number; adjusted: boolean } | null
  >();
  constructor(
    bars: PriceBar[],
    spyBars: PriceBar[] | null,
    // β for a date: null = unknown (1 is assumed); the SPY ticker passes 0.
    private betaOf: (date: string) => number | null,
  ) {
    const spyBy = new Map<string, Float64Array>();
    for (const b of spyBars ?? []) {
      if (b.session !== "regular") continue;
      let a = spyBy.get(b.date);
      if (!a) spyBy.set(b.date, (a = new Float64Array(1441).fill(NaN)));
      a[b.minute] = b.close;
    }
    for (const a of spyBy.values()) {
      let last = NaN;
      for (let m = 0; m < 1441; m++) {
        if (!Number.isNaN(a[m]!)) last = a[m]!;
        a[m] = last;
      }
    }
    for (const b of bars) {
      let d = this.days.get(b.date);
      if (!d) {
        d = {
          close: b.regularClose ?? 960,
          opens: new Float64Array(1441).fill(NaN),
          closes: new Float64Array(1441).fill(NaN),
          spy: spyBy.get(b.date) ?? null,
        };
        this.days.set(b.date, d);
        this.dates.push(b.date);
      }
      if (b.session !== "regular") continue;
      d.opens[b.minute] = b.open;
      d.closes[b.minute] = b.close;
    }
    this.dates.sort();
  }

  private beta(date: string) {
    const b = this.betaOf(date);
    return { value: b ?? 1, assumed: b === null };
  }

  // Entry end-minute for an alert ending at `alertMinute`, or null.
  private entryMinute(d: Day, alertMinute: number) {
    for (
      let m = alertMinute + 1;
      m <= alertMinute + entryWithin && m <= d.close;
      m++
    )
      if (!Number.isNaN(d.opens[m]!)) return m;
    return null;
  }

  // Signed peak log move from entry within the horizon, market-adjusted when
  // SPY has a price for the session; null when there is no bar.
  private peak(date: string, alertMinute: number, h: LookNowHorizon) {
    const key = `${date}|${alertMinute}|${h}`;
    if (this.peakCache.has(key)) return this.peakCache.get(key)!;
    const value = this.computePeak(date, alertMinute, h);
    this.peakCache.set(key, value);
    return value;
  }
  private computePeak(
    date: string,
    alertMinute: number,
    h: LookNowHorizon,
  ): { move: number; adjusted: boolean } | null {
    const d = this.days.get(date);
    const e = d ? this.entryMinute(d, alertMinute) : null;
    if (!d || e === null) return null;
    const last = h === "close" ? d.close : e + h - 1;
    if (last > d.close) return null;
    const beta = this.beta(date).value;
    // SPY at entry: the last close before the entry minute, else its first
    // later one. Minutes before SPY's first bar use the entry level.
    let spyEntry = NaN;
    if (d.spy && beta !== 0) {
      spyEntry = d.spy[e - 1]!;
      for (let m = e; Number.isNaN(spyEntry) && m <= last; m++)
        spyEntry = d.spy[m]!;
    }
    const adjusted = !Number.isNaN(spyEntry);
    const level = (price: number, m: number) => {
      if (!adjusted) return Math.log(price);
      const spy = d.spy![m]!;
      return (
        Math.log(price) - beta * Math.log(Number.isNaN(spy) ? spyEntry : spy)
      );
    };
    const x0 =
      Math.log(d.opens[e]!) - (adjusted ? beta * Math.log(spyEntry) : 0);
    let hi = -Infinity;
    let lo = Infinity;
    for (let m = e; m <= last; m++) {
      const c = d.closes[m]!;
      if (Number.isNaN(c)) continue;
      const v = level(c, m);
      if (v > hi) hi = v;
      if (v < lo) lo = v;
    }
    if (hi === -Infinity) return null;
    return { move: hi - x0 >= x0 - lo ? hi - x0 : lo - x0, adjusted };
  }

  private sigma(date: string, alertMinute: number, h: LookNowHorizon) {
    const i = this.dates.indexOf(date);
    const samples: number[] = [];
    for (let j = Math.max(0, i - sigmaSessions); j < i; j++) {
      const p = this.peak(this.dates[j]!, alertMinute, h);
      if (p !== null) samples.push(Math.abs(p.move));
    }
    if (samples.length < minSigmaSamples) return null;
    samples.sort((a, b) => a - b);
    const n = samples.length;
    return (samples[(n - 1) >> 1]! + samples[n >> 1]!) / 2;
  }

  /** Raw per-horizon moves for an alert ending at `date`/`alertMinute`. */
  measure(date: string, alertMinute: number, session: string): Measured {
    if (session !== "regular")
      return { ok: false, reason: "Outside regular hours" };
    const d = this.days.get(date);
    if (!d) return { ok: false, reason: "No bars that day" };
    if (alertMinute >= d.close)
      return { ok: false, reason: "No time left in the session" };
    const e = this.entryMinute(d, alertMinute);
    if (e === null) return { ok: false, reason: "No trade after the alert" };
    const moves: Omit<HorizonMove, "percentile">[] = [];
    let anyBars = false;
    for (const h of lookNowHorizons) {
      const p = this.peak(date, alertMinute, h);
      if (p === null) continue;
      anyBars = true;
      const s = this.sigma(date, alertMinute, h);
      if (s === null || s <= 0) continue;
      moves.push({
        horizon: h,
        move: (Math.exp(p.move) - 1) * 100,
        sigma: (Math.exp(s) - 1) * 100,
        z: Math.abs(p.move) / s,
        marketAdjusted: p.adjusted,
      });
    }
    if (!moves.length)
      return {
        ok: false,
        reason: anyBars ? "Not enough history" : "No bars after the entry",
      };
    return { ok: true, entry: e, moves };
  }

  /** Every `step`-th regular minute in [from, to], with its last 3-minute
   * direction, measured the same way (the random-minute baseline). */
  baseline(from: string, to: string, step = 5) {
    const out: {
      direction: "up" | "down";
      measured: Measured & { ok: true };
    }[] = [];
    for (const date of this.dates) {
      if (date < from || date > to) continue;
      const d = this.days.get(date)!;
      for (let m = 571 + 3; m < d.close; m++) {
        if (m % step) continue;
        const a = d.closes[m]!;
        const b = d.closes[m - 3]!;
        if (Number.isNaN(a) || Number.isNaN(b) || a === b) continue;
        const measured = this.measure(date, m, "regular");
        if (measured.ok)
          out.push({ direction: a > b ? "up" : "down", measured });
      }
    }
    return out;
  }

  betaInfo(date: string) {
    const b = this.betaOf(date);
    return { beta: b ?? 1, assumed: b === null };
  }
}

/** Sorted |z| of random minutes per horizon, for percentile ranks. */
export type Ranks = Map<LookNowHorizon, Float64Array>;

export function ranks(samples: Measured[]): Ranks {
  const by = new Map<LookNowHorizon, number[]>();
  for (const s of samples)
    if (s.ok)
      for (const m of s.moves) {
        const list = by.get(m.horizon) ?? [];
        list.push(m.z);
        by.set(m.horizon, list);
      }
  const out: Ranks = new Map();
  for (const [h, list] of by)
    if (list.length >= minBaseline) out.set(h, Float64Array.from(list).sort());
  return out;
}

/**
 * Random-minute measurements kept as one z per horizon, so a long offline run
 * (millions of minutes) fits in memory. Ranks and scores match `ranks` and
 * `lookNow` on the full measurements.
 */
export class RandomMinutes {
  private readonly z = lookNowHorizons.map(() => [] as number[]); // NaN = none
  private count = 0;

  add(measured: Measured) {
    if (!measured.ok) return;
    lookNowHorizons.forEach((h, i) =>
      this.z[i]!.push(measured.moves.find((m) => m.horizon === h)?.z ?? NaN),
    );
    this.count++;
  }

  /** z per horizon, aligned by sample (NaN = none); see `addColumns`. */
  columns(): number[][] {
    return this.z.map((column) => [...column]);
  }

  addColumns(columns: number[][]) {
    if (
      columns.length !== this.z.length ||
      new Set(columns.map((c) => c.length)).size > 1
    )
      throw new Error("Random-minute columns must align with the horizons");
    columns.forEach((column, i) => {
      const target = this.z[i]!;
      for (const z of column) target.push(z);
    });
    this.count += columns[0]?.length ?? 0;
  }

  ranks(): Ranks {
    const out: Ranks = new Map();
    lookNowHorizons.forEach((h, i) => {
      const list = this.z[i]!.filter((v) => !Number.isNaN(v));
      if (list.length >= minBaseline)
        out.set(h, Float64Array.from(list).sort());
    });
    return out;
  }

  /** Each random minute's look-now score against `rank`. */
  scores(rank: Ranks): { score: number | null }[] {
    const out: { score: number | null }[] = [];
    for (let k = 0; k < this.count; k++) {
      const moves: Omit<HorizonMove, "percentile">[] = [];
      lookNowHorizons.forEach((horizon, i) => {
        const z = this.z[i]![k]!;
        if (!Number.isNaN(z))
          moves.push({ horizon, z, move: 0, sigma: 0, marketAdjusted: false });
      });
      const { score } = lookNow(
        { ok: true, entry: 0, moves },
        null,
        rank,
        null,
        null,
        null,
      );
      out.push({ score });
    }
    return out;
  }
}

// Share of random minutes with z at or below this one, 0–100.
function percentileOf(sorted: Float64Array, z: number) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= z) lo = mid + 1;
    else hi = mid;
  }
  return (lo / sorted.length) * 100;
}

/** Final score for one measurement, ranked against the random minutes. */
export function lookNow(
  measured: Measured,
  direction: "up" | "down" | null,
  rank: Ranks,
  beta: { beta: number; assumed: boolean } | null,
  closeMinute: number | null,
  alertMinute: number | null,
): LookNow {
  const nearClose =
    closeMinute !== null &&
    alertMinute !== null &&
    closeMinute - alertMinute < 60;
  const empty = (reason: string): LookNow => ({
    score: null,
    label: null,
    reason,
    horizons: [],
    peak: null,
    withBurst: null,
    nearClose,
    beta: beta?.beta ?? null,
    betaAssumed: beta?.assumed ?? false,
  });
  if (!measured.ok) return empty(measured.reason);
  const horizons: HorizonMove[] = measured.moves.map((m) => {
    const sorted = rank.get(m.horizon);
    return { ...m, percentile: sorted ? percentileOf(sorted, m.z) : null };
  });
  const ranked = horizons.filter((h) => h.percentile !== null);
  if (!ranked.length)
    return { ...empty("Not enough random minutes to rank"), horizons };
  const weight = ranked.reduce((s, h) => s + lookNowWeights[h.horizon], 0);
  const score =
    ranked.reduce((s, h) => s + lookNowWeights[h.horizon] * h.percentile!, 0) /
    weight;
  const top = ranked.reduce((a, b) => (b.percentile! > a.percentile! ? b : a));
  return {
    score,
    label:
      score >= veryBigScore ? "very-big" : score >= bigScore ? "big" : "normal",
    horizons,
    peak: top.horizon,
    withBurst:
      direction === null ? null : top.move >= 0 === (direction === "up"),
    nearClose,
    beta: beta?.beta ?? null,
    betaAssumed: beta?.assumed ?? false,
  };
}

export interface LookNowSummary {
  scored: number;
  unscored: number;
  reasons: Record<string, number>;
  averageScore: number | null;
  big: number; // score ≥ 90, including very big
  veryBig: number;
  withBurst: number; // of scored alerts
  peaks: Record<string, number>;
  baseline: {
    scored: number;
    averageScore: number | null;
    big: number;
    veryBig: number;
  };
}

export function summarizeLookNow(
  alerts: LookNow[],
  randoms: Pick<LookNow, "score">[],
): LookNowSummary {
  const stats = (list: Pick<LookNow, "score">[]) => {
    const scored = list.filter((l) => l.score !== null);
    return {
      scored: scored.length,
      averageScore: scored.length
        ? scored.reduce((s, l) => s + l.score!, 0) / scored.length
        : null,
      big: scored.filter((l) => l.score! >= bigScore).length,
      veryBig: scored.filter((l) => l.score! >= veryBigScore).length,
    };
  };
  const reasons: Record<string, number> = {};
  const peaks: Record<string, number> = {};
  for (const a of alerts) {
    if (a.reason) reasons[a.reason] = (reasons[a.reason] ?? 0) + 1;
    if (a.peak !== null)
      peaks[String(a.peak)] = (peaks[String(a.peak)] ?? 0) + 1;
  }
  const own = stats(alerts);
  return {
    ...own,
    unscored: alerts.length - own.scored,
    reasons,
    withBurst: alerts.filter((a) => a.withBurst === true).length,
    peaks,
    baseline: stats(randoms),
  };
}
