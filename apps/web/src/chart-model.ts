// Pure helpers for the day chart: volume strength, opposite-to-benchmark
// summaries and readout state text. No DOM access, so Node tests import it.
import type {
  ChartBar,
  DayChart,
} from "../../../packages/market-data/src/day-chart.js";
import type { AreaVsSpySeries } from "../../../packages/contracts/src/vs-spy.js";
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

export interface ChartScores {
  scores: (number | null)[]; // aligned with the requested ticker's bars
  gap: (number | null)[]; // % points, aligned likewise
  windows: AreaVsSpySeries["windows"];
  latest: number | null; // at the last bar
  beta: number;
  betaAssumed: boolean;
}

const finiteOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Area score vs SPY and gap per minute of the requested ticker, from the
 * backend's `areaVsSpy`. Null when the response has none or the ticker is
 * SPY itself; minutes the series do not cover are null ("—", no gap drawn).
 */
export function chartScores(data: DayChart): ChartScores | null {
  const main = data.series[0];
  const area = data.areaVsSpy;
  if (!main || !area || main.ticker === scoreBenchmark) return null;
  const align = (xs: unknown[] | undefined) =>
    main.bars.map((_, i) => finiteOrNull(xs?.[i]));
  const scores = align(area.score);
  return {
    scores,
    gap: align(area.gap),
    windows: Array.isArray(area.windows) ? area.windows : [],
    latest: scores.at(-1) ?? null,
    beta: area.beta,
    betaAssumed: area.betaAssumed,
  };
}

/** The score's weight window: the last 60 minutes up to the end minute E. */
export const weightMinutes = 60;

/**
 * Bar index of the end minute E the header score ends at. In the "Around
 * alert" view of an alert chart: the last bar closing at or before the
 * alert's window start (alert bar close − `windowMinutes`), so the alert's
 * own minutes are excluded, the same E as the alert's tag and Telegram line;
 * -1 when no bar closes that early. Otherwise the latest bar (-1 without
 * bars). `alertMs` is the alert bar's close (ms); NaN without an alert.
 */
export function endIndex(
  bars: { start: number }[],
  alertMs: number,
  windowMinutes: number,
  aroundAlert: boolean,
): number {
  if (!aroundAlert || Number.isNaN(alertMs)) return bars.length - 1;
  const cutoff = alertMs - windowMinutes * 60000;
  for (let i = bars.length - 1; i >= 0; i--)
    if ((bars[i]!.start + 60) * 1000 <= cutoff) return i;
  return -1;
}

/**
 * Weight of the minute starting at `start` (Unix s) for the end minute
 * starting at `endStart`: w = (60 − (E − i)) / 60 for 0 ≤ E − i < 60 clock
 * minutes, else 0 (older, or after E).
 */
export function minuteWeight(start: number, endStart: number): number {
  const age = Math.round((endStart - start) / 60);
  return age >= 0 && age < weightMinutes
    ? (weightMinutes - age) / weightMinutes
    : 0;
}

/** Bar opacity at weight 1 (the end minute) and just above 0 (60 min old). */
export const opacityRange = { newest: 1, oldest: 0.22 } as const;
/** Opacity of a bar outside the weight window (older, or after E). */
export const outsideOpacity = 0.07;

/**
 * Opacity of a contribution bar: linear in its weight from `oldest` (weight
 * → 0) to `newest` (weight 1); bars that do not count get `outsideOpacity`.
 */
export function barOpacity(weight: number): number {
  if (!(weight > 0)) return outsideOpacity;
  const { newest, oldest } = opacityRange;
  return oldest + (newest - oldest) * Math.min(1, weight);
}

export interface ContributionBar {
  value: number | null; // c(i), % points; null when the minute is unmarked
  weight: number; // w(i) for the end minute, 0 outside its 60 minutes
  opacity: number;
  up: boolean; // c ≥ 0 → green
  inWindow: boolean; // inside the shaded 60-minute weight window
}

/**
 * Contributions pane bars relative to end bar `end` (the header's E):
 * value from the backend's per-minute contribution, weight and opacity by
 * clock-minute age. Without an end bar every weight is 0.
 */
export function contributionBars(
  bars: { start: number }[],
  contribution: (number | null)[],
  end: number,
): ContributionBar[] {
  const endStart = bars[end]?.start;
  return bars.map((b, i) => {
    const c = contribution[i];
    const value = typeof c === "number" && Number.isFinite(c) ? c : null;
    const weight = endStart === undefined ? 0 : minuteWeight(b.start, endStart);
    return {
      value,
      weight,
      opacity: barOpacity(weight),
      up: (value ?? 0) >= 0,
      inWindow: weight > 0,
    };
  });
}

/**
 * Bars of the alert's own window (closing after alert close − window and at
 * or before the alert close): excluded from the alert's score. Empty without
 * an alert or a window.
 */
export function alertWindowBars(
  bars: { start: number }[],
  alertMs: number,
  windowMinutes: number,
): number[] {
  if (Number.isNaN(alertMs) || windowMinutes <= 0) return [];
  const from = alertMs - windowMinutes * 60000;
  const out: number[] = [];
  bars.forEach((b, i) => {
    const close = (b.start + 60) * 1000;
    if (close > from && close <= alertMs) out.push(i);
  });
  return out;
}

/** "+0.42 pts" / "−1.10 pts" for the contributions pane. */
export const gapPoints = (n: number) => `${signed(n)} pts`;

/** "72 / 100", or "—" without a score. */
export const scoreText = (score: number | null | undefined) =>
  score === null || score === undefined ? "—" : `${score} / 100`;
