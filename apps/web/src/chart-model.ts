// Pure helpers for the day chart: volume strength, opposite-to-benchmark
// summaries and readout state text. No DOM access, so Node tests import it.
import type { ChartBar } from "../../../packages/market-data/src/day-chart.js";
import type {
  OppositeEpisode,
  OppositeKind,
} from "../../../packages/market-data/src/opposite.js";

/** A minute's volume is drawn at full strength from this multiple of typical. */
export const strongVolume = 2;

/** Ratio to typical volume, or null when typical is unknown or zero. */
export function typicalRatio(
  volume: number,
  typical: number | null | undefined,
): number | null {
  return typical ? volume / typical : null;
}

/** Full strength at ≥ 2× typical; faded otherwise, including unknown typical. */
export const isStrongVolume = (
  volume: number,
  typical: number | null | undefined,
) => (typicalRatio(volume, typical) ?? 0) >= strongVolume;

/** Minutes covered by an episode, from its window start to its last bar. */
export const episodeMinutes = (e: OppositeEpisode, bars: ChartBar[]) =>
  Math.round(((bars[e.to]?.start ?? 0) - (bars[e.from]?.start ?? 0)) / 60);

/** "Held while SPY fell: 1 time · 10 min" or "…: none today". */
export function episodeSummary(
  kind: OppositeKind,
  episodes: OppositeEpisode[],
  bars: ChartBar[],
  against: string,
  today: boolean,
): string {
  const label =
    kind === "strong"
      ? `Held while ${against} fell`
      : `Fell while ${against} held`;
  const mine = episodes.filter((e) => e.kind === kind);
  if (!mine.length) return `${label}: none${today ? " today" : ""}`;
  const minutes = mine.reduce((m, e) => m + episodeMinutes(e, bars), 0);
  return `${label}: ${mine.length} ${mine.length === 1 ? "time" : "times"} · ${minutes} min`;
}

/** Readout chip for one bar's state. */
export function stateText(kind: OppositeKind | null, against: string): string {
  return kind === "strong"
    ? `▲ Holding while ${against} falls`
    : kind === "weak"
      ? `▼ Falling while ${against} holds`
      : `With ${against}`;
}

/**
 * Bar index → episode kind, covering each episode from its window start to
 * its last minute (how bands are drawn).
 */
export function bandKinds(
  count: number,
  episodes: OppositeEpisode[],
): (OppositeKind | null)[] {
  const kinds: (OppositeKind | null)[] = new Array(count).fill(null);
  for (const e of episodes)
    for (let i = Math.max(0, e.from); i <= e.to && i < count; i++)
      kinds[i] = kinds[i] === "strong" ? "strong" : e.kind;
  return kinds;
}

/** Backtest scoring levels for an alert's simulated entry, as prices. */
export interface OutcomeLevels {
  entry: number;
  good: number;
  stop: number;
}

/**
 * Entry, good and stop prices: good is `goodUnits` u in the alert's
 * direction from the entry, stop `stopUnits` u against it (u = the outcome's
 * unit, a percent). Null when the alert was not scored.
 */
export function outcomeLevels(
  outcome: { entry: number | null; unit: number | null },
  direction: "up" | "down",
  units: { goodUnits: number; stopUnits: number },
): OutcomeLevels | null {
  const { entry, unit } = outcome;
  if (entry === null || unit === null) return null;
  const sign = direction === "up" ? 1 : -1;
  return {
    entry,
    good: entry * (1 + (sign * units.goodUnits * unit) / 100),
    stop: entry * (1 - (sign * units.stopUnits * unit) / 100),
  };
}
