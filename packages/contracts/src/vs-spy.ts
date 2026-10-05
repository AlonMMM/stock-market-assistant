// Marked-sections score vs SPY on alerts, the live "now" score, the board
// and the day chart (docs/features/marks-vs-spy.md). Pure and
// dependency-free: the collector, the backtest, Telegram and the web app
// share it.

/** `vsSpy` on an alert record (live store, /api/live, backtest alerts). */
export interface AlertVsSpy {
  // Marked-sections score (0–100) at the alert's end minute E (the last
  // minute before the alert's own `config.window` minutes):
  // round(100 · Φ(sum / σ)). Null without σ (fewer than 15 of the previous
  // 20 sessions, or σ = 0 before marks can exist), without SPY data, for
  // SPY itself, or when the alert bar or E is outside the regular session.
  // Alerts stored before it carry an older score (area or day-based).
  score: number | null;
  // I = Σ w(i) · c(i) over the marked minutes of the 60 up to E, % points
  // (4 decimals). Null when the score is null for a reason other than σ.
  // Always present on new alerts; alerts stored before the marked-sections
  // score lack it (read as null).
  sum?: number | null;
  beta: number; // 60-session daily β vs SPY; 1 when assumed
  betaAssumed: boolean;
  // True when SPY had no bar of its own at E (the collector waited at most
  // 3 s for it, then SPY's last close was carried forward). Evidence only.
  spyLagged: boolean;
  /**
   * @deprecated Area of the replaced area score; present only on alerts
   * stored before the marked-sections score. Never shown.
   */
  area?: number | null;
  /**
   * @deprecated Direction label of the replaced day-based score; present only
   * on alerts stored before the area score. Never shown.
   */
  label?: VsSpyLabel;
}

/** Score "now" per symbol with an alert today (Israel day), in /api/live. */
export interface StrengthNow {
  // Marked-sections score with E = the symbol's latest bar; once that bar
  // is after-hours, E = its last regular bar of that date (the day's closing
  // score); null while the latest bar is pre-market.
  score: number | null;
  at: string; // UTC end of the bar at E
}

/** Minutes in the weight window: w(i) = (60 − (E − i)) / 60. */
export const marksWeightMinutes = 60;

/**
 * Day chart's marked-sections series (`DayChart.marksVsSpy`), one entry per
 * regular-session minute of the chart date: index k is the minute bar that
 * starts at `start + 60·k` (09:30 New York is k = 0), through the requested
 * ticker's last regular bar. Absent for SPY itself or without SPY's minute
 * bars; empty arrays when the ticker has no regular bar yet.
 *
 * Contributions do not depend on the end minute; `score[k]`, `sum[k]` and
 * `sigma[k]` are the values with E = minute k. The web draws a bar's weight
 * relative to its chosen end minute with `marksWeight`.
 */
export interface MarksVsSpySeries {
  start: number; // Unix s of 09:30 New York (k = 0)
  // c(k) = tR − β·bR of a marked minute (5-minute moves, % points from the
  // previous close); null when minute k is unmarked. The sign can differ from
  // the mark's colour with β ≠ 1; bars are coloured by sign.
  contribution: (number | null)[];
  // Mark of minute k from opposite(): "strong" (green, held while SPY fell),
  // "weak" (red, fell while SPY held), null unmarked.
  mark: ("strong" | "weak" | null)[];
  sum: (number | null)[]; // I with E = k, % points
  sigma: (number | null)[]; // σ at minute k (same minute, 20 sessions)
  score: (number | null)[]; // 0–100 with E = k ("Score N" readout); null → "—"
  beta: number; // 60-session daily β vs SPY; 1 when assumed
  betaAssumed: boolean;
}

/** Weight of minute `minute` for end minute `end` (both Unix s of bar starts). */
export function marksWeight(end: number, minute: number): number {
  const age = Math.round((end - minute) / 60);
  return age >= 0 && age < marksWeightMinutes
    ? (marksWeightMinutes - age) / marksWeightMinutes
    : 0;
}

/**
 * End minute E of an alert (Unix s of E's bar start): the last minute before
 * the alert's own window, i.e. the alert bar's end (`alert.end`) minus
 * `window + 1` minutes. E.g. an alert bar ending 15:50 with window 3 → E is
 * the 15:46 bar; the 15:47–15:49 bars are excluded.
 */
export function marksAlertEnd(alertEnd: string, window: number): number {
  return Date.parse(alertEnd) / 1000 - 60 * (window + 1);
}

/**
 * Score of a chart series at end minute `end` (Unix s of a bar start); null
 * outside the series (before 09:30, after the ticker's last regular bar or
 * outside the regular session). Matches the alert's score at its E.
 */
export function marksScoreAt(
  series: Pick<MarksVsSpySeries, "start" | "score"> | null | undefined,
  end: number,
): number | null {
  if (!series) return null;
  const k = (end - series.start) / 60;
  if (!Number.isInteger(k) || k < 0) return null;
  return series.score[k] ?? null;
}

/**
 * @deprecated Area series of the replaced area score; never sent any more.
 * Kept only until the web reads `marksVsSpy`.
 */
export interface AreaVsSpySeries {
  gap: (number | null)[];
  area: (number | null)[];
  score: (number | null)[];
  sigma: (number | null)[];
  windows: { session: "pre" | "regular" | "post"; start: number }[];
  beta: number;
  betaAssumed: boolean;
}

// Colour thresholds of the score: ≥ 60 green (stronger than SPY), ≤ 40 red
// (weaker), between grey (normal).
export const vsSpyStrong = 60;
export const vsSpyWeak = 40;

export type VsSpyTone = "stronger" | "weaker" | "normal" | "none";

/** Colour/word of a score: stronger ≥ 60, weaker ≤ 40, normal between. */
export function vsSpyTone(score: number | null | undefined): VsSpyTone {
  if (score === null || score === undefined || !Number.isFinite(score))
    return "none";
  return score >= vsSpyStrong
    ? "stronger"
    : score <= vsSpyWeak
      ? "weaker"
      : "normal";
}

/** Telegram line: "vs SPY 72/100", or "vs SPY —" without a score. */
export function vsSpyLine(
  vsSpy: Pick<AlertVsSpy, "score"> | null | undefined,
): string {
  const score = vsSpy?.score;
  return score === null || score === undefined || !Number.isFinite(score)
    ? "vs SPY —"
    : `vs SPY ${score}/100`;
}

/** @deprecated Labels were removed (area-vs-spy); kept until the web drops them. */
export type VsSpyLabel = "confirmed" | "against" | "market" | "none";

/** @deprecated Labels were removed (area-vs-spy); use `vsSpyTone`. */
export function vsSpyLabel(
  direction: "up" | "down" | null | undefined,
  score: number | null | undefined,
): VsSpyLabel {
  if (score === null || score === undefined || !Number.isFinite(score))
    return "none";
  if (score > vsSpyWeak && score < vsSpyStrong) return "market";
  if (direction !== "up" && direction !== "down") return "none";
  const strong = score >= vsSpyStrong;
  return (direction === "up") === strong ? "confirmed" : "against";
}

/** @deprecated Labels were removed (area-vs-spy); use `vsSpyLine`. */
export function vsSpyText(
  direction: "up" | "down" | null | undefined,
  vsSpy: Pick<AlertVsSpy, "score" | "label"> | null | undefined,
): string {
  const score = vsSpy?.score;
  if (!vsSpy || score === null || score === undefined) return "vs SPY —";
  const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "•";
  const value = `${score}/100`;
  switch (vsSpy.label ?? vsSpyLabel(direction, score)) {
    case "confirmed":
      return `${arrow} ${direction === "up" ? "Long" : "Short"} · confirmed vs SPY · ${value}`;
    case "against":
      return `${arrow} ${direction === "up" ? "Up" : "Down"} · against SPY · ${value}`;
    case "market":
      return `${arrow} · moving with market · ${value}`;
    default:
      return `${arrow} · vs SPY · ${value}`;
  }
}
