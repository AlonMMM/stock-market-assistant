// How close each stock is to a Volume bot alert (user 2026-11-02: "I can't
// understand from the map if we are close to alert or not"). The alert needs
// four checks at once (packages/trading/src/strangle/alert.ts): the last 3
// minutes' volume 4× usual, their move 3× usual, 10,000 shares and a 0.5%
// price move. The map draws only the first two; a stock can sit by the corner
// and still be far from an alert on the other two. Readiness is the weakest
// check's share of what it needs: 100% on all four alerts. No DOM access, so
// Node tests import it.
import { alertRule } from "../../../packages/trading/src/strangle/alert.js";
import type { StrangleScanRow } from "../../../packages/trading/src/strangle/view.js";

export interface AlertCheck {
  key: "volume" | "move" | "shares" | "price";
  name: string; // short, for the pips
  value: number;
  need: number;
  share: number; // value / need, capped at 1
  met: boolean;
  text: string; // "move 2.4× of 3×"
}

// Readings round down, so a check short of its need never reads as its need (3.98× is "3.9× of 4.0×").
const down = (v: number, digits: number) =>
  Math.floor(v * 10 ** digits) / 10 ** digits;
const ratio = (v: number) => `${down(v, 1).toFixed(1)}×`;
const pct = (v: number) => `${down(v, 2).toFixed(2)}%`;
const count = (v: number) => Math.round(v).toLocaleString("en-US");

function check(
  key: AlertCheck["key"],
  name: string,
  value: number,
  need: number,
  show: (v: number) => string,
  what: string,
): AlertCheck {
  const share = need > 0 ? Math.min(1, Math.max(0, value / need)) : 1;
  return {
    key,
    name,
    value,
    need,
    share,
    met: value >= need,
    text: `${what} ${show(value)} of ${show(need)}`,
  };
}

/** The alert's four checks for one stock, in the order the alert reads them. */
export function alertChecks(r: StrangleScanRow): AlertCheck[] {
  return [
    check("volume", "Vol", r.volRatio, alertRule.threshold, ratio, "volume"),
    check("move", "Move", r.moveRatio, alertRule.priceMultiple, ratio, "move"),
    check("shares", "Shares", r.shares, alertRule.minVolume, count, "shares"),
    check("price", "%", r.movePct, alertRule.minMovePercent, pct, "price move"),
  ];
}

export interface Readiness {
  share: number; // the weakest check's share, 0–1; 1 alerts
  met: number; // checks met, 0–4
  missing: AlertCheck[]; // the checks not met, weakest first
}

/** The weakest check decides: a stock is as close to an alert as its farthest check. */
export function readiness(r: StrangleScanRow): Readiness {
  const checks = alertChecks(r);
  const missing = checks
    .filter((c) => !c.met)
    .sort((a, b) => a.share - b.share);
  return {
    share: Math.min(...checks.map((c) => c.share)),
    met: checks.length - missing.length,
    missing,
  };
}

/** What is still missing, in words: "needs price move 0.06% of 0.50%". */
export function missingText(x: Readiness): string {
  if (x.missing.length === 0)
    return "All four met: it alerts when the minute closes the same way";
  return `needs ${x.missing.map((c) => c.text).join(" · ")}`;
}

/** The stocks by readiness, the closest first; ties by the volume check. */
export function byReadiness(
  scan: readonly StrangleScanRow[],
): StrangleScanRow[] {
  return [...scan].sort(
    (a, b) =>
      readiness(b).share - readiness(a).share || b.volRatio - a.volRatio,
  );
}

// The trend: each stock's readiness by minute, kept while the page is open.
export const trendMinutes = 20;
export type Trend = Map<number, number>; // session minute -> readiness share

/** The trend with this minute's reading; minutes older than the window are dropped. */
export function addReading(trend: Trend, minute: number, share: number): Trend {
  const next = new Map(trend);
  next.set(minute, share);
  for (const m of next.keys()) if (m <= minute - trendMinutes) next.delete(m);
  return next;
}

/** Rising, falling or flat: this minute against the trend's earliest, by 5 points. */
export function trendWay(trend: Trend): "up" | "down" | "flat" {
  const minutes = [...trend.keys()].sort((a, b) => a - b);
  if (minutes.length < 2) return "flat";
  const change = trend.get(minutes.at(-1)!)! - trend.get(minutes[0]!)!;
  if (change >= 0.05) return "up";
  if (change <= -0.05) return "down";
  return "flat";
}
