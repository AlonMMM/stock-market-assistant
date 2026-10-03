// "Opposite to benchmark" display aid for the day chart (docs/features/live-page.md).
// Pure and browser-safe: the web app imports it directly. It is not a validated
// signal and must not be described as predictive.
import { newYork, newYorkToUtc } from "./calendar.js";
import type { ChartSeries } from "./day-chart.js";

export interface OppositeOptions {
  window: number; // minutes between the compared closes
  benchFall: number; // strong: benchmark move ≤ this (% points)
  benchHold: number; // weak: benchmark move ≥ this (% points)
  weakMultiple: number; // weak: ticker move ≤ −weakMultiple × usual
  minUsualMoves: number; // today's moves needed before any weak state
}

// Proposed thresholds, user-agreed rule shape (2026-10-03).
export const oppositeDefaults: Readonly<OppositeOptions> = Object.freeze({
  window: 5,
  benchFall: -0.05,
  benchHold: -0.02,
  weakMultiple: 2,
  minUsualMoves: 15,
});

export type OppositeKind = "strong" | "weak";

export interface OppositeEpisode {
  kind: OppositeKind;
  from: number; // ticker bar index of the window start (i − window)
  to: number; // ticker bar index of the episode's last minute
}

export interface Opposite {
  states: (OppositeKind | null)[]; // aligned to ticker.bars
  episodes: OppositeEpisode[];
}

// Absorbs float noise from % arithmetic so −0.05 exactly counts as −0.05.
const epsilon = 1e-9;

// Regular-session % from previous close, by bar start (Unix s). A minute with
// no bar had no trade, so a lookup carries the latest earlier close forward
// within the session; `index` is the bar that close came from.
function regularPercents(series: ChartSeries) {
  const times: number[] = [];
  const values: number[] = [];
  const indices: number[] = [];
  const base = series.previousClose;
  if (base && base > 0)
    series.bars.forEach((bar, index) => {
      if (bar.session !== "regular") return;
      times.push(bar.start);
      values.push((bar.close / base - 1) * 100);
      indices.push(index);
    });
  return {
    // Latest bar at or before `time` (and at or after `from`), else null.
    at(time: number, from: number): { value: number; index: number } | null {
      let lo = 0;
      let hi = times.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid]! <= time) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (found < 0 || times[found]! < from) return null;
      return { value: values[found]!, index: indices[found]! };
    },
  };
}

function insertSorted(sorted: number[], value: number) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  sorted.splice(lo, 0, value);
}

function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Per ticker bar: "strong" when the benchmark fell over the window while the
 * ticker held, "weak" when the ticker fell unusually while the benchmark held.
 * Regular session only; bars are aligned by timestamp, never by index.
 */
export function opposite(
  ticker: ChartSeries,
  bench: ChartSeries,
  options: Partial<OppositeOptions> = {},
): Opposite {
  const o = { ...oppositeDefaults, ...options };
  const states: (OppositeKind | null)[] = ticker.bars.map(() => null);
  const from: number[] = ticker.bars.map(() => -1);
  const t = regularPercents(ticker);
  const b = regularPercents(bench);
  const moves: number[] = []; // today's |ticker moves| so far, sorted
  const span = o.window * 60;
  ticker.bars.forEach((bar, i) => {
    if (bar.session !== "regular" || ticker.previousClose === null) return;
    const ny = newYork(bar.start * 1000);
    const open = newYorkToUtc(ny.date, 570) / 1000;
    // i ≥ open + window: both ends of the window inside the regular session.
    if (bar.start - span < open) return;
    const now = t.at(bar.start, bar.start);
    const before = t.at(bar.start - span, open);
    if (!now || !before) return;
    const tR = now.value - before.value;
    insertSorted(moves, Math.abs(tR));
    const bNow = b.at(bar.start, open);
    const bBefore = b.at(bar.start - span, open);
    if (!bNow || !bBefore) return;
    const bR = bNow.value - bBefore.value;
    from[i] = before.index;
    if (bR <= o.benchFall + epsilon && tR >= -epsilon) states[i] = "strong";
    else if (bR >= o.benchHold - epsilon && moves.length >= o.minUsualMoves) {
      const usual = median(moves);
      // A zero baseline would mark flat minutes as falls; require a real fall.
      if (usual > 0 && tR <= -o.weakMultiple * usual + epsilon)
        states[i] = "weak";
    }
  });
  const episodes: OppositeEpisode[] = [];
  states.forEach((kind, i) => {
    if (!kind) return;
    const last = episodes.at(-1);
    if (last && last.kind === kind && last.to === i - 1) last.to = i;
    else episodes.push({ kind, from: from[i]!, to: i });
  });
  return { states, episodes };
}
