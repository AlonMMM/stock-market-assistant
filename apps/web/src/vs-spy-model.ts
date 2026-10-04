// Pure view logic for the score vs SPY (docs/features/marks-vs-spy.md):
// the score cell on Live and Backtest alert rows, the watchlist column and
// the expanded "at alert → now" line. No direction labels: a cell shows only
// the score and its colour. No DOM access, so Node tests import it.
import {
  vsSpyStrong,
  vsSpyTone,
  vsSpyWeak,
  type AlertVsSpy,
  type StrengthNow,
  type VsSpyTone,
} from "../../../packages/contracts/src/vs-spy.js";
import { israelDay } from "./time.js";

export type { StrengthNow, VsSpyTone };
// Old stored alerts may lack `area` and still carry a direction `label`;
// the label is ignored.
export type VsSpy = Omit<AlertVsSpy, "area" | "label"> & {
  area?: number | null;
  label?: string;
};

/** Colour thresholds from the shared contract: green ≥ 60, red ≤ 40. */
export const scoreStrong = vsSpyStrong;
export const scoreWeak = vsSpyWeak;

/** Colour of a score (the shared `vsSpyTone`); also the CSS class. */
export const scoreTone = vsSpyTone;

/** Words for the accessible label and tooltip; never shown as a tag. */
export const toneWords: Record<VsSpyTone, string> = {
  stronger: "stronger vs SPY",
  weaker: "weaker vs SPY",
  normal: "normal vs SPY",
  none: "no score vs SPY",
};

/** Explains the score in tooltips, legends and table notes. */
export const scoreNote =
  "marked minutes only, each sized by the stock's 5-min move minus β × SPY's; recent minutes weigh more; the alert's own minutes are excluded; 50 = normal";

export interface VsSpyCell {
  tone: VsSpyTone;
  text: string; // the score, or "—"
  score: number | null;
  title: string; // accessible description and tooltip
}

/** A score with its colour and words; `when` names the moment, if any. */
export function scoreCell(
  score: number | null | undefined,
  when = "",
): VsSpyCell {
  const tone = scoreTone(score);
  const at = when ? ` ${when}` : "";
  if (tone === "none")
    return { tone, text: "—", score: null, title: `No score vs SPY${at}` };
  return {
    tone,
    text: String(score),
    score: score!,
    title: `vs SPY ${score} / 100${at}: ${toneWords[tone]} (${scoreNote})`,
  };
}

/** Alert row cell: the alert-time score only; a stored label is ignored. */
export const vsSpyCell = (v: VsSpy | null | undefined): VsSpyCell =>
  scoreCell(v?.score, "at the alert");

/** Minimum change in score for the trend arrow to point up or down. */
export const trendStep = 5;

export type Trend = "↑" | "↓" | "→";

/** ↑ when now − at-alert ≥ 5, ↓ when ≤ −5, otherwise →. */
export function strengthTrend(atAlert: number, now: number): Trend {
  const d = now - atAlert;
  return d >= trendStep ? "↑" : d <= -trendStep ? "↓" : "→";
}

/**
 * The current score applies only to alerts from the same Israel day as the
 * score's bars; an older alert of the same symbol keeps its alert-time score.
 */
export function nowForAlert(
  alertEnd: string,
  now: StrengthNow | undefined,
): StrengthNow | null {
  if (!now) return null;
  return israelDay(Date.parse(alertEnd)) === israelDay(Date.parse(now.at))
    ? now
    : null;
}

const beta = (v: VsSpy) =>
  `β ${v.beta.toFixed(1)}${v.betaAssumed ? " (assumed)" : ""}`;

/**
 * Expanded-row line, e.g. "vs SPY at alert 72 → now 64 ↓ · β 2.0".
 * `now` is omitted when unknown (Backtest, older alerts, no live data).
 */
export function vsSpyDetail(
  v: VsSpy | null | undefined,
  now: StrengthNow | null = null,
): string {
  if (!v) return "vs SPY at alert — (not available for this alert)";
  const at =
    v.score === null || v.score === undefined
      ? "— (no score)"
      : String(v.score);
  let line = `vs SPY at alert ${at}`;
  if (now && now.score !== null)
    line +=
      v.score === null || v.score === undefined
        ? ` · now ${now.score}`
        : ` → now ${now.score} ${strengthTrend(v.score, now.score)}`;
  return `${line} · ${beta(v)}`;
}
