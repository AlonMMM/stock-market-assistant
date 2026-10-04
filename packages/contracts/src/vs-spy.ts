// Area score vs SPY on alerts, the live "now" score and the day chart
// (docs/features/area-vs-spy.md). Pure and dependency-free: the collector,
// the backtest, Telegram and the web app share it.

/** `vsSpy` on an alert record (live store, /api/live, backtest alerts). */
export interface AlertVsSpy {
  // Area score (0–100) ending at the alert bar: round(100 · Φ(area / σ)).
  // Null without σ (fewer than 15 of the previous 20 sessions), without SPY
  // data, for SPY itself, or in a window's first 5 minutes.
  score: number | null;
  // Weighted area between the stock and β × SPY over the alert's session
  // window to the alert bar, % points. Alerts stored before the area score
  // lack it (read as null); their `score` is the old day-based score.
  area: number | null;
  beta: number; // 60-session daily β vs SPY; 1 when assumed
  betaAssumed: boolean;
  // True when SPY's bar for the alert's own minute was not used (it had not
  // arrived within the wait, or SPY had no bar that minute): SPY's last close
  // was carried forward. Evidence only.
  spyLagged: boolean;
  /**
   * @deprecated Direction label of the replaced day-based score; present only
   * on alerts stored before the area score. Never shown.
   */
  label?: VsSpyLabel;
}

/** Score "now" per symbol with an alert today (Israel day), in /api/live. */
export interface StrengthNow {
  score: number | null; // area score ending at the symbol's latest bar
  at: string; // UTC end of the symbol's latest bar behind the score
}

/**
 * Day chart's area series (`DayChart.areaVsSpy`), aligned with the requested
 * ticker's bars (`series[0].bars`); each value ends at that bar's minute.
 * Absent for SPY itself or without SPY's minute bars.
 */
export interface AreaVsSpySeries {
  gap: (number | null)[]; // s − β·m at the minute, % points (the gap pane)
  area: (number | null)[]; // weighted area of the window to the minute
  score: (number | null)[]; // 0–100 ("Score N" readout); null → "—"
  sigma: (number | null)[]; // σ at the minute (same minute, 20 sessions)
  // Start (t0, Unix s) of each session window present, for the weight ramp:
  // w(t) = (t − t0 + 1) / (T − t0 + 1), t and T in minutes.
  windows: { session: "pre" | "regular" | "post"; start: number }[];
  beta: number; // 60-session daily β vs SPY; 1 when assumed
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
