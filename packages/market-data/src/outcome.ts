import type { PriceBar } from "./bars.js";
import { previousSessions } from "./calendar.js";

// Alert validation for momentum (0DTE-style) entries, proposed to the user on
// 2026-09-27. Entry is the open of the minute after the alert. Moves are
// measured in units (u) of the symbol's typical `unitMinutes` move at that
// time of day (median |move| over the previous `unitDays` sessions). The entry
// is "stopped" when a minute closes `stopUnits` u against the alert, "good"
// when a close runs `goodUnits` u in its favour first, and "weak" when neither
// happens within `horizon` minutes or before the regular close.
export interface ValidationConfig {
  horizon: number; // minutes after entry
  stopUnits: number;
  goodUnits: number;
  unitMinutes: number;
  unitDays: number;
}
export const validationDefaults: ValidationConfig = {
  horizon: 60,
  stopUnits: 1,
  goodUnits: 2,
  unitMinutes: 15,
  unitDays: 20,
};
const forwardMinutes = [5, 15, 30, 60] as const;
const minUnitSamples = 10;

export type OutcomeResult = "good" | "stopped" | "weak" | "unscored";

export interface Outcome {
  result: OutcomeResult;
  reason?: string; // why unscored
  entry: number | null; // price
  entryAt: string | null; // entry bar start, UTC ISO
  unit: number | null; // percent
  minutes: number | null; // entry → good/stopped
  run: number | null; // best close in the alert's favour, percent
  pullback: number | null; // worst close against it before the result, percent
  runUnits: number | null;
  forward: Record<(typeof forwardMinutes)[number], number | null>; // percent
}

export class ValidationInputError extends Error {}

export function parseValidation(input: unknown): ValidationConfig {
  const config = {
    ...validationDefaults,
    ...(input && typeof input === "object" ? input : {}),
  } as ValidationConfig;
  if (
    !Number.isInteger(config.horizon) ||
    config.horizon < 1 ||
    config.horizon > 390 ||
    !(config.stopUnits > 0 && config.stopUnits <= 20) ||
    !(config.goodUnits > 0 && config.goodUnits <= 50) ||
    !Number.isInteger(config.unitMinutes) ||
    config.unitMinutes < 1 ||
    config.unitMinutes > 120 ||
    !Number.isInteger(config.unitDays) ||
    config.unitDays < 5 ||
    config.unitDays > 60
  )
    throw new ValidationInputError("Invalid validation settings");
  return config;
}

const median = (values: number[]) => {
  const v = [...values].sort((a, b) => a - b);
  return (
    (v[Math.floor((v.length - 1) / 2)]! + v[Math.floor(v.length / 2)]!) / 2
  );
};

const unscored = (reason: string): Outcome => ({
  result: "unscored",
  reason,
  entry: null,
  entryAt: null,
  unit: null,
  minutes: null,
  run: null,
  pullback: null,
  runUnits: null,
  forward: { 5: null, 15: null, 30: null, 60: null },
});

/** One symbol's chronological bars, indexed for outcome scoring. */
export class OutcomeScorer {
  private index = new Map<string, number>(); // bar end → position
  private closes = new Map<string, Map<number, number>>(); // date → minute → close
  constructor(
    private bars: PriceBar[],
    private config: ValidationConfig = validationDefaults,
  ) {
    bars.forEach((bar, i) => {
      this.index.set(bar.end, i);
      let day = this.closes.get(bar.date);
      if (!day) this.closes.set(bar.date, (day = new Map()));
      day.set(bar.minute, bar.close);
    });
  }

  // Median |move| over `unitMinutes` starting at `minute` on earlier sessions.
  private unit(date: string, minute: number): number | null {
    let dates: string[];
    try {
      dates = previousSessions(date, this.config.unitDays);
    } catch {
      return null;
    }
    const moves: number[] = [];
    for (const d of dates) {
      const day = this.closes.get(d);
      const a = day?.get(minute);
      const b = day?.get(minute + this.config.unitMinutes);
      if (a && b) moves.push(Math.abs(b / a - 1) * 100);
    }
    return moves.length >= minUnitSamples ? median(moves) : null;
  }

  /** Scores an entry after the bar ending at `signalEnd`, in `direction`. */
  score(signalEnd: string, direction: "up" | "down"): Outcome {
    const i = this.index.get(signalEnd);
    if (i === undefined) return unscored("Signal bar not found");
    const signal = this.bars[i]!;
    const entryBar = this.bars[i + 1];
    if (
      !entryBar ||
      entryBar.date !== signal.date ||
      entryBar.minute !== signal.minute + 1
    )
      return unscored("No bar in the minute after the alert");
    if (entryBar.session !== "regular")
      return unscored("Entry outside regular hours");
    const unit = this.unit(entryBar.date, entryBar.minute - 1);
    if (unit === null || unit <= 0)
      return unscored("Not enough history for the symbol's typical move");
    const sign = direction === "up" ? 1 : -1;
    const entry = entryBar.open;
    const startMs = Date.parse(entryBar.end) - 60000;
    const closeMinute = entryBar.regularClose ?? 960;
    const favour = (price: number) => sign * (price / entry - 1) * 100;
    const forward: Outcome["forward"] = {
      5: null,
      15: null,
      30: null,
      60: null,
    };
    let result: OutcomeResult = "weak";
    let minutes: number | null = null;
    let run = -Infinity;
    let pullback = Infinity;
    for (let j = i + 1; j < this.bars.length; j++) {
      const bar = this.bars[j]!;
      const elapsed = (Date.parse(bar.end) - startMs) / 60000;
      if (bar.date !== entryBar.date || bar.minute > closeMinute) break;
      for (const k of forwardMinutes)
        if (elapsed <= k) forward[k] = favour(bar.close);
      if (elapsed > this.config.horizon) continue;
      const f = favour(bar.close);
      if (result === "weak") {
        run = Math.max(run, f);
        pullback = Math.min(pullback, f);
        if (f <= -this.config.stopUnits * unit) {
          result = "stopped";
          minutes = elapsed;
        } else if (f >= this.config.goodUnits * unit) {
          result = "good";
          minutes = elapsed;
        }
      }
    }
    return {
      result,
      entry,
      entryAt: new Date(startMs).toISOString(),
      unit,
      minutes,
      run: Number.isFinite(run) ? run : null,
      pullback: Number.isFinite(pullback) ? pullback : null,
      runUnits: Number.isFinite(run) ? run / unit : null,
      forward,
    };
  }

  /**
   * Baseline: every `step`-th regular minute, entering in the direction of
   * its last three-minute move, scored the same way as alerts.
   */
  baseline(from: string, to: string, step = 5): Outcome[] {
    const outcomes: Outcome[] = [];
    this.bars.forEach((bar, i) => {
      if (
        bar.session !== "regular" ||
        bar.date < from ||
        bar.date > to ||
        bar.minute % step !== 0
      )
        return;
      const back = this.bars[i - 3];
      if (!back || back.date !== bar.date || bar.close === back.close) return;
      const outcome = this.score(
        bar.end,
        bar.close > back.close ? "up" : "down",
      );
      if (outcome.result !== "unscored") outcomes.push(outcome);
    });
    return outcomes;
  }
}

/** Baseline (random-entry) outcome counts; `scored` = good + stopped + weak. */
export interface BaselineCounts {
  scored: number;
  good: number;
  stopped: number;
  weak: number;
}

export interface ValidationSummary {
  config: ValidationConfig;
  scored: number;
  unscored: number;
  good: number;
  stopped: number;
  weak: number;
  medianRunUnits: number | null;
  medianMinutesToGood: number | null;
  medianForward: Record<(typeof forwardMinutes)[number], number | null>;
  baseline: BaselineCounts;
  // The same baseline entries split by symbol: one key per requested ticker
  // (zeros when it had no scored baseline entries), summing to `baseline`.
  // Set by POST /api/backtest since the Backtest page redesign; absent from
  // older API responses and from `summarize()` itself, so treat a missing
  // map or ticker as "unknown", not as zero.
  baselineBySymbol?: Record<string, BaselineCounts>;
}

export function summarize(
  outcomes: Outcome[],
  baseline: Outcome[],
  config: ValidationConfig,
): ValidationSummary {
  const scored = outcomes.filter((o) => o.result !== "unscored");
  const count = (list: Outcome[], r: OutcomeResult) =>
    list.filter((o) => o.result === r).length;
  const med = (values: (number | null)[]) => {
    const v = values.filter((x): x is number => x !== null);
    return v.length ? median(v) : null;
  };
  return {
    config,
    scored: scored.length,
    unscored: outcomes.length - scored.length,
    good: count(scored, "good"),
    stopped: count(scored, "stopped"),
    weak: count(scored, "weak"),
    medianRunUnits: med(scored.map((o) => o.runUnits)),
    medianMinutesToGood: med(
      scored.filter((o) => o.result === "good").map((o) => o.minutes),
    ),
    medianForward: {
      5: med(scored.map((o) => o.forward[5])),
      15: med(scored.map((o) => o.forward[15])),
      30: med(scored.map((o) => o.forward[30])),
      60: med(scored.map((o) => o.forward[60])),
    },
    baseline: baselineCounts(baseline),
  };
}

/** Counts baseline outcomes (`OutcomeScorer.baseline` keeps scored ones only). */
export function baselineCounts(baseline: Outcome[]): BaselineCounts {
  const count = (r: OutcomeResult) =>
    baseline.filter((o) => o.result === r).length;
  return {
    scored: baseline.length,
    good: count("good"),
    stopped: count("stopped"),
    weak: count("weak"),
  };
}
