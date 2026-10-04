// Score vs SPY at the moment an alert fires (docs/features/alert-vs-spy.md),
// shared by the live collector and the backtest. Same formula and inputs as
// the alert analysis' day score (packages/analysis/src/relative-strength.ts):
// % from each symbol's previous regular close (its last regular minute bar)
// to the alert bar's close and SPY's close of the same minute.
import { vsSpyLabel, type AlertVsSpy } from "../../contracts/src/vs-spy.js";
import type { PriceBar } from "./bars.js";
import { excessPercent, rsScore, type SpyStrength } from "./rs-score.js";

const change = (from: number, to: number) => (to / from - 1) * 100;

export interface AlertVsSpyInput {
  direction: "up" | "down" | null;
  close: number | null | undefined; // the alert bar's close
  previousClose: number | null | undefined; // the stock's previous regular close
  spyClose: number | null | undefined; // SPY's close for the alert minute
  spyPreviousClose: number | null | undefined;
  // β/σ for the alert's session date; null when unavailable (β 1, assumed).
  strength: Pick<SpyStrength, "beta" | "betaAssumed" | "sigma"> | null;
  spyLagged: boolean;
}

/** Score vs SPY from closes: null score whenever an input is missing. */
export function scoreVsSpy(
  close: number | null | undefined,
  previousClose: number | null | undefined,
  spyClose: number | null | undefined,
  spyPreviousClose: number | null | undefined,
  beta: number,
  sigma: number | null,
): number | null {
  if (!close || !previousClose || !spyClose || !spyPreviousClose) return null;
  return rsScore(
    excessPercent(
      change(previousClose, close),
      change(spyPreviousClose, spyClose),
      beta,
    ),
    sigma,
  );
}

export function alertVsSpy(input: AlertVsSpyInput): AlertVsSpy {
  const beta = input.strength?.beta ?? 1;
  const score = scoreVsSpy(
    input.close,
    input.previousClose,
    input.spyClose,
    input.spyPreviousClose,
    beta,
    input.strength?.sigma ?? null,
  );
  return {
    score,
    beta,
    betaAssumed: input.strength?.betaAssumed ?? true,
    label: vsSpyLabel(input.direction, score),
    spyLagged: input.spyLagged,
  };
}

/** Close of the last regular-session bar dated `date`, if any. */
export function regularClose(bars: PriceBar[], date: string): number | null {
  let close: number | null = null;
  for (const bar of bars)
    if (bar.date === date && bar.session === "regular") close = bar.close;
  return close;
}

/**
 * SPY's bar for an alert minute: the bar ending at `end` if present, else the
 * newest earlier bar of the same New York date (`lagged`).
 */
export function spyBarFor(
  spy: PriceBar[],
  date: string,
  end: string,
): { bar: PriceBar | null; lagged: boolean } {
  let found: PriceBar | null = null;
  for (const bar of spy)
    if (bar.date === date && bar.end <= end && (!found || bar.end > found.end))
      found = bar;
  return { bar: found, lagged: found?.end !== end };
}
