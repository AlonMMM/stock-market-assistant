// Score vs SPY at the moment an alert fires, and its direction label
// (docs/features/alert-vs-spy.md). Pure and dependency-free: the collector,
// the backtest, Telegram and the web app share it.

export type VsSpyLabel = "confirmed" | "against" | "market" | "none";

/** `vsSpy` on an alert record (live store, /api/live, backtest alerts). */
export interface AlertVsSpy {
  // Shared rsScore (0–100) with the alert bar's close and SPY's close, both
  // % from the previous regular close; null without σ, a base or a SPY bar.
  score: number | null;
  beta: number; // 60-session daily β vs SPY; 1 when assumed
  betaAssumed: boolean;
  label: VsSpyLabel;
  // True when SPY's bar for the alert's own minute was not used (it had not
  // arrived within the wait, or SPY had no bar that minute): the newest
  // earlier SPY bar of the same day was used instead. Evidence only.
  spyLagged: boolean;
}

/** Score "now" per symbol with an alert today (Israel day), in /api/live. */
export interface StrengthNow {
  score: number | null;
  at: string; // UTC end of the symbol's latest bar behind the score
}

// Label thresholds (proposals, to be validated by backtest).
export const vsSpyStrong = 60;
export const vsSpyWeak = 40;

/**
 * Direction label from the alert's move and its score vs SPY:
 * ▲ ≥ 60 or ▼ ≤ 40 → confirmed; ▲ ≤ 40 or ▼ ≥ 60 → against; 41–59 → market;
 * no score (or no direction) → none.
 */
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

/**
 * One-line text, e.g. "▲ Long · confirmed vs SPY · 78/100",
 * "▲ Up · against SPY · 38/100", "▼ · moving with market · 50/100", or
 * "vs SPY —" without a score. Never a trade recommendation.
 */
export function vsSpyText(
  direction: "up" | "down" | null | undefined,
  vsSpy: Pick<AlertVsSpy, "score" | "label"> | null | undefined,
): string {
  const score = vsSpy?.score;
  if (!vsSpy || score === null || score === undefined) return "vs SPY —";
  const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "•";
  const value = `${score}/100`;
  switch (vsSpy.label) {
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
