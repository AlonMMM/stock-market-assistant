import type { RawBar } from "./bars.js";
import { newYork } from "./calendar.js";

export const benchmark = "SPY";

// Beta: OLS slope of the ticker's daily close-to-close returns on SPY's over
// the 60 trading sessions before the chart day (user-confirmed 2026-09-26).
export const betaReturns = 60;
const betaMinimumReturns = 40;

export function dailyCloses(rows: RawBar[]): Map<string, number> {
  const closes = new Map<string, number>();
  for (const row of rows)
    if (Number.isFinite(row.close) && row.close > 0)
      closes.set(newYork(row.start * 1000).date, row.close);
  return closes;
}

/** Beta from daily closes on consecutive sessions present for both symbols. */
export function dailyBeta(
  sessions: string[],
  ticker: RawBar[],
  market: RawBar[],
): { value: number | null; returns: number } {
  const a = dailyCloses(ticker);
  const m = dailyCloses(market);
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 1; i < sessions.length; i++) {
    const [p, d] = [sessions[i - 1]!, sessions[i]!];
    const [a0, a1, m0, m1] = [a.get(p), a.get(d), m.get(p), m.get(d)];
    if (a0 && a1 && m0 && m1) {
      y.push(a1 / a0 - 1);
      x.push(m1 / m0 - 1);
    }
  }
  const n = x.length;
  if (n < betaMinimumReturns) return { value: null, returns: n };
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i]! - mx) * (y[i]! - my);
    variance += (x[i]! - mx) ** 2;
  }
  return { value: variance > 0 ? cov / variance : null, returns: n };
}
