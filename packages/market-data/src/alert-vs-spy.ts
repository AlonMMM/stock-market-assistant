// Marked-sections score vs SPY at the moment an alert fires
// (docs/features/marks-vs-spy.md), shared by the live collector and the
// backtest: the score at the alert's end minute E, the last minute before the
// alert's own window, so the alert's own move is excluded.
import type { AlertVsSpy } from "../../contracts/src/vs-spy.js";
import { coreClose, newYorkToUtc } from "./calendar.js";
import {
  alertEndMinute,
  byDate,
  dayMarks,
  daySeries,
  marksAt,
  marksBenchmark,
  regularOpen,
  type MarkBar,
  type MarksSigma,
} from "./marks-vs-spy.js";

export interface AlertVsSpyInput {
  ticker: string;
  date: string; // New York session date of the alert bar
  minute: number; // the alert bar's New York start minute
  window: number; // the alert's `config.window` (minutes)
  // The stock's and SPY's bars of `date`, plus the previous session's for
  // the previous close (else the date's first regular open is the base).
  stock: MarkBar[];
  spy: MarkBar[];
  beta: number; // 60-session daily β vs SPY; 1 when assumed
  betaAssumed: boolean;
  sigma: MarksSigma | null; // σ curve for the ticker and date
}

export function alertVsSpy(input: AlertVsSpyInput): AlertVsSpy {
  const end = alertEndMinute(input.minute, input.window);
  const regular =
    input.minute >= regularOpen &&
    input.minute < (coreClose(input.date) ?? 960);
  const stockDays = byDate(input.stock);
  const spyDays = byDate(input.spy);
  const value = regular
    ? marksAt(
        input.ticker,
        dayMarks(
          daySeries(input.ticker, stockDays, input.date),
          daySeries(marksBenchmark, spyDays, input.date),
          input.date,
        ),
        end,
        input.beta,
        input.sigma,
      )
    : { sum: null, score: null };
  const endStart = newYorkToUtc(input.date, end) / 1000;
  return {
    score: value.score,
    sum: value.sum === null ? null : Number(value.sum.toFixed(4)),
    beta: input.beta,
    betaAssumed: input.betaAssumed,
    // SPY had no bar of its own at E: its last close was carried.
    spyLagged: !(spyDays.get(input.date) ?? []).some(
      (b) => b.start === endStart,
    ),
  };
}
