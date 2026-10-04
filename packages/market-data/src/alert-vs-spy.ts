// Area score vs SPY at the moment an alert fires (docs/features/area-vs-spy.md),
// shared by the live collector and the backtest: the area ending at the alert
// bar's minute, from the stock's and SPY's minute bars of that session.
import type { AlertVsSpy } from "../../contracts/src/vs-spy.js";
import { areaAt, type AreaBar, type SigmaCurve } from "./area-vs-spy.js";

export interface AlertVsSpyInput {
  ticker: string;
  date: string; // New York session date of the alert bar
  minute: number; // the alert bar's New York start minute
  stock: AreaBar[]; // the stock's bars of `date` (later ones are ignored)
  spy: AreaBar[]; // SPY's bars of `date`
  beta: number; // 60-session daily β vs SPY; 1 when assumed
  betaAssumed: boolean;
  sigma: SigmaCurve | null; // σ curve for the ticker and date
}

export function alertVsSpy(input: AlertVsSpyInput): AlertVsSpy {
  const value = areaAt(input, input.minute);
  return {
    score: value.score,
    area: value.area === null ? null : Number(value.area.toFixed(4)),
    beta: input.beta,
    betaAssumed: input.betaAssumed,
    // SPY's own bar of the alert minute was missing: its close was carried.
    spyLagged: !input.spy.some(
      (b) => b.date === input.date && b.minute === input.minute,
    ),
  };
}
