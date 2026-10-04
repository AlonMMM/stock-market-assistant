// Pure view logic for the alert-time score vs SPY (docs/features/alert-vs-spy.md):
// the label cell on Live and Backtest alert rows and the expanded
// "at alert → now" line. No DOM access, so Node tests import it.
import {
  vsSpyLabel,
  vsSpyText,
  type AlertVsSpy,
  type StrengthNow,
  type VsSpyLabel,
} from "../../../packages/contracts/src/vs-spy.js";
import { israelDay } from "./time.js";

export type { StrengthNow };
export type VsSpy = AlertVsSpy;

export type VsSpyTone = VsSpyLabel;

export interface VsSpyCell {
  tone: VsSpyTone; // colour: confirmed green, against red, market grey
  text: string; // arrow and words, always present beside the colour
  score: number | null;
  title: string; // accessible description of the whole cell
}

const words: Record<
  "up" | "down",
  Record<Exclude<VsSpyTone, "none">, string>
> = {
  up: {
    confirmed: "▲ Long · confirmed",
    against: "▲ Up · against",
    market: "▲ · moving with market",
  },
  down: {
    confirmed: "▼ Short · confirmed",
    against: "▼ Down · against",
    market: "▼ · moving with market",
  },
};

/**
 * The row cell: the label stored with the alert (from the shared
 * `vsSpyLabel`; thresholds are not re-derived here) and the score. "—" without a score or a `vsSpy`.
 */
export function vsSpyCell(
  direction: "up" | "down",
  v: VsSpy | null | undefined,
): VsSpyCell {
  // Compatibility until the labels are removed here (area-vs-spy): alerts
  // stored after the area score carry no label.
  const label = v ? (v.label ?? vsSpyLabel(direction, v.score)) : "none";
  if (!v || label === "none" || v.score === null)
    return {
      tone: "none",
      text: "—",
      score: null,
      title: "No score vs SPY for this alert",
    };
  return {
    tone: label,
    text: words[direction][label],
    score: v.score,
    // The shared one-line text, as in the Telegram alert.
    title: `${vsSpyText(direction, v)} at the alert`,
  };
}

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
 * Expanded-row line, e.g. "vs SPY at alert 78 → now 84 ↑ · β 1.4".
 * `now` is omitted when unknown (Backtest, older alerts, no live data).
 */
export function vsSpyDetail(
  v: VsSpy | null | undefined,
  now: StrengthNow | null = null,
): string {
  if (!v) return "vs SPY at alert — (not available for this alert)";
  const at = v.score === null ? "— (no score)" : String(v.score);
  let line = `vs SPY at alert ${at}`;
  if (now && now.score !== null)
    line +=
      v.score === null
        ? ` · now ${now.score}`
        : ` → now ${now.score} ${strengthTrend(v.score, now.score)}`;
  return `${line} · ${beta(v)}`;
}
