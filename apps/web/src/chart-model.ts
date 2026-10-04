// Pure helpers for the day chart: volume strength, opposite-to-benchmark
// summaries and readout state text. No DOM access, so Node tests import it.
import type {
  ChartBar,
  DayChart,
} from "../../../packages/market-data/src/day-chart.js";
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

/** "+2.31" / "−0.40" (true minus sign). */
export const signed = (n: number) =>
  `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;

/** "+2.31%" / "−0.40%". */
export const signedPercent = (n: number) => `${signed(n)}%`;

/** "$131.62". */
export const dollars = (n: number) => `$${n.toFixed(2)}`;

/** The base for intraday %: previous regular close, else the first trade. */
export const percentBase = (series: {
  previousClose: number | null;
  bars: { close: number }[];
}) => series.previousClose ?? series.bars[0]?.close ?? 1;

/** Price at `percent` from `base`. */
export const priceAt = (percent: number, base: number) =>
  base * (1 + percent / 100);

/** "+2.31% · $131.62": a percentage with the price behind it. */
export const percentAndPrice = (percent: number, price: number) =>
  `${signedPercent(percent)} · ${dollars(price)}`;

/**
 * Axis last-value labels carry the price only where both axes still leave
 * room for the plot; narrower charts keep % only (the readout has prices).
 */
export const axisPriceMinWidth = 600;

/** The score vs SPY is always against this symbol. */
export const scoreBenchmark = "SPY";

/**
 * Per-minute area-score series of the requested ticker as the backend sends
 * them in `vsSpy` (docs/features/area-vs-spy.md), aligned with its bars:
 * gap(t) = s(t) − β·m(t) in % points since the session's first bar, and the
 * area score ending at that minute. Precomputed; the web never re-derives
 * the formula.
 */
export interface AreaSeries {
  gap?: (number | null)[];
  scores?: (number | null)[];
}

export interface ChartScores {
  scores: (number | null)[]; // aligned with the requested ticker's bars
  gap: (number | null)[]; // % points, aligned likewise
  latest: number | null; // at the last bar
  beta: number;
  betaAssumed: boolean;
}

const finiteOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Area score vs SPY per minute of the requested ticker, from the backend's
 * series. Null when the response has no `vsSpy` or the ticker is SPY itself;
 * minutes the series do not cover are null ("—", no gap drawn).
 */
export function chartScores(data: DayChart): ChartScores | null {
  const main = data.series[0];
  const vs = data.vsSpy as (DayChart["vsSpy"] & AreaSeries) | undefined;
  if (!main || !vs || main.ticker === scoreBenchmark) return null;
  const align = (xs: unknown[] | undefined) =>
    main.bars.map((_, i) => finiteOrNull(xs?.[i]));
  const scores = align(vs.scores);
  return {
    scores,
    gap: align(vs.gap),
    latest: scores.at(-1) ?? null,
    beta: vs.beta,
    betaAssumed: vs.betaAssumed,
  };
}

/**
 * Bar index the header score ends at: the alert's bar in the "Around alert"
 * view of an alert chart, else the latest bar. -1 without bars.
 */
export function headerIndex(
  count: number,
  alertIndex: number,
  aroundAlert: boolean,
): number {
  if (aroundAlert && alertIndex >= 0 && alertIndex < count) return alertIndex;
  return count - 1;
}

/**
 * Display hint for the gap pane: the linear weight w(t) = (t − t0 + 1) /
 * (T − t0 + 1) by minute, from the first bar of the session that contains
 * bar `end` (consecutive bars with the same session label) through `end`;
 * null outside that window.
 */
export function weightRamp(
  bars: { start: number; session: string }[],
  end: number,
): (number | null)[] {
  const ramp: (number | null)[] = bars.map(() => null);
  const last = bars[end];
  if (!last) return ramp;
  let first = end;
  while (first > 0 && bars[first - 1]!.session === last.session) first--;
  const t0 = bars[first]!.start;
  const span = (last.start - t0) / 60 + 1;
  for (let i = first; i <= end; i++)
    ramp[i] = ((bars[i]!.start - t0) / 60 + 1) / span;
  return ramp;
}

/** "+0.42 pts" / "−1.10 pts" for the gap pane. */
export const gapPoints = (n: number) => `${signed(n)} pts`;

/** "72 / 100", or "—" without a score. */
export const scoreText = (score: number | null | undefined) =>
  score === null || score === undefined ? "—" : `${score} / 100`;
