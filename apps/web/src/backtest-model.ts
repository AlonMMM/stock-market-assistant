// Pure view logic for the Backtest page: rule change tracking, setup presets,
// session date ranges, the verdict, per-symbol stats, data-quality status and
// merging batch results. No DOM access, so Node tests import it.
import {
  defaults,
  type Config,
} from "../../../packages/alerts/src/relative-volume.js";
import type {
  BacktestAlert,
  BacktestResult,
} from "../../../packages/market-data/src/backtest.js";
import {
  coreClose,
  newYork,
  newYorkToUtc,
  previousSessions,
} from "../../../packages/market-data/src/calendar.js";
import {
  summarizeLookNow,
  type LookNow,
  type LookNowLabel,
  type LookNowSummary,
} from "../../../packages/market-data/src/look-now.js";
import {
  summarize,
  type BaselineCounts,
  type ValidationConfig,
  type ValidationSummary,
} from "../../../packages/market-data/src/outcome.js";
import {
  backtestLimits,
  maxSymbolsPerRequest,
} from "../../../packages/market-data/src/backtest-limits.js";

export const liveRule = "rvol-v4";
export const maxSessions = backtestLimits.sessions;

// ------------------------------------------------------------ rule fields

export type RuleKey =
  | "threshold"
  | "minVolume"
  | "paceMultiple"
  | "priceMultiple"
  | "minMovePercent"
  | "lastBarMinMovePercent"
  | "directionBars"
  | "todayVolumeMultiple"
  | "todayMoveMultiple"
  | "inPlayDayRvol"
  | "cooldown";

export type RuleSettings = Pick<Config, RuleKey>;

export interface RuleField {
  key: RuleKey;
  label: string;
  hint?: string; // shown after the label when unchanged, e.g. "0 = off"
  min: string;
  max?: string;
  step: string;
}

/** Rule fields in four groups; ranges match the server's validation. */
export const ruleGroups: { title: string; fields: RuleField[] }[] = [
  {
    title: "Volume burst",
    fields: [
      {
        key: "threshold",
        label: "Volume (× typical)",
        min: "1.1",
        step: "0.1",
      },
      { key: "minVolume", label: "Minimum volume", min: "0", step: "1" },
      {
        key: "paceMultiple",
        label: "Today's pace (×)",
        hint: "0 = off",
        min: "0",
        step: "0.1",
      },
    ],
  },
  {
    title: "Price move",
    fields: [
      {
        key: "priceMultiple",
        label: "Move (× typical)",
        min: "1",
        step: "0.1",
      },
      {
        key: "minMovePercent",
        label: "Minimum move (%)",
        min: "0",
        max: "100",
        step: "0.05",
      },
      {
        key: "lastBarMinMovePercent",
        label: "Last-minute move (%)",
        hint: "0 = off",
        min: "0",
        max: "100",
        step: "0.05",
      },
      {
        key: "directionBars",
        label: "Same-direction candles",
        min: "1",
        max: "3",
        step: "1",
      },
    ],
  },
  {
    title: "Today-relative (optional)",
    fields: [
      {
        key: "todayVolumeMultiple",
        label: "Burst vs today's volume (×)",
        hint: "0 = off",
        min: "0",
        max: "100",
        step: "0.1",
      },
      {
        key: "todayMoveMultiple",
        label: "Move vs today's typical (×)",
        hint: "0 = off",
        min: "0",
        max: "100",
        step: "0.1",
      },
    ],
  },
  {
    title: "Tags and pacing",
    fields: [
      {
        key: "inPlayDayRvol",
        label: "In play: day volume (×)",
        hint: "0 = off",
        min: "0",
        max: "100",
        step: "0.1",
      },
      {
        key: "cooldown",
        label: "Cooldown (min)",
        min: "0",
        max: "1440",
        step: "1",
      },
    ],
  },
];

export const ruleKeys: RuleKey[] = ruleGroups.flatMap((g) =>
  g.fields.map((f) => f.key),
);

/** The live rule's settings (the shared engine defaults). */
export const liveSettings: RuleSettings = Object.fromEntries(
  ruleKeys.map((k) => [k, defaults[k]]),
) as RuleSettings;

/** Keys whose value differs from the live rule. */
export function ruleChanges(
  settings: RuleSettings,
  live: RuleSettings = liveSettings,
): RuleKey[] {
  return ruleKeys.filter((k) => settings[k] !== live[k]);
}

/** "Live settings" / "1 change from live" / "3 changes from live". */
export function changeBadge(changes: number): string {
  return changes === 0
    ? "Live settings"
    : `${changes} ${changes === 1 ? "change" : "changes"} from live`;
}

/** "rvol-v4" / "rvol-v4 + 1 change". */
export function ruleLabel(changes: number): string {
  return changes === 0
    ? liveRule
    : `${liveRule} + ${changes} ${changes === 1 ? "change" : "changes"}`;
}

const number = (n: number) => n.toLocaleString("en-US");

/** One sentence describing a rule's settings, generated from the values. */
export function ruleSummary(s: RuleSettings = liveSettings): string {
  const volume =
    `volume ≥ ${s.threshold}× typical for that minute` +
    (s.paceMultiple > 0 ? ` or ≥ ${s.paceMultiple}× today's pace` : "") +
    (s.minVolume > 0 ? `, at least ${number(s.minVolume)} shares` : "");
  const move =
    `move ≥ ${s.priceMultiple}× typical` +
    (s.minMovePercent > 0 ? ` and ≥ ${s.minMovePercent}%` : "") +
    (s.lastBarMinMovePercent > 0
      ? `, last minute ≥ ${s.lastBarMinMovePercent}%`
      : "");
  const candles = `${s.directionBars} ${s.directionBars === 1 ? "candle" : "candles"} in the move's direction`;
  const today = [
    s.todayVolumeMultiple > 0 &&
      `burst ≥ ${s.todayVolumeMultiple}× today's volume level`,
    s.todayMoveMultiple > 0 &&
      `move ≥ ${s.todayMoveMultiple}× today's typical move`,
  ].filter(Boolean);
  return (
    `${volume}; ${move}; ${candles}` +
    (today.length ? `; ${today.join(", ")}` : "") +
    `; ${s.cooldown} min cooldown.` +
    (s.inPlayDayRvol > 0
      ? ` Tagged in play at ${s.inPlayDayRvol}× usual day volume.`
      : "")
  );
}

// ---------------------------------------------------------- symbol presets

// Symbols per run (the page batches them; see symbolsPerBatch).
export const maxTickers = 250;
export const symbolPattern = /^[A-Z][A-Z0-9. -]{0,9}$/;

/** "amd, ARM tsm" → valid symbols (upper case, de-duplicated) and invalid ones. */
export function parseSymbols(text: string): {
  valid: string[];
  invalid: string[];
} {
  const words = [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((w) => w.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  return {
    valid: words.filter((w) => symbolPattern.test(w)),
    invalid: words.filter((w) => !symbolPattern.test(w)),
  };
}

export interface SymbolPreset {
  key: string;
  label: string;
  tickers: string[];
  disabled: string | null; // reason when it cannot be used
}

/**
 * The backtest symbol list (when given), the whole watchlist, symbols alerted
 * in the current live feed, and one preset per sector benchmark ETF used in
 * the watchlist; each capped at maxTickers.
 */
export function symbolPresets(
  watchlist: { tickers: string[]; benchmarks: Record<string, string> },
  liveAlerts: { ticker: string }[] | null,
  backtestList?: string[] | null,
): SymbolPreset[] {
  const alerted = [...new Set((liveAlerts ?? []).map((a) => a.ticker))];
  const presets: SymbolPreset[] = [];
  if (backtestList !== undefined)
    presets.push({
      key: "list",
      label: "Backtest list",
      tickers: (backtestList ?? []).slice(0, maxTickers),
      disabled:
        backtestList === null
          ? "Loading the list"
          : backtestList.length
            ? null
            : "The list is empty",
    });
  presets.push(
    {
      key: "all",
      label: "Whole watchlist",
      tickers: watchlist.tickers.slice(0, maxTickers),
      disabled: watchlist.tickers.length ? null : "The watchlist is empty",
    },
    {
      key: "alerted",
      label: "Alerted recently",
      tickers: alerted.slice(0, maxTickers),
      disabled:
        liveAlerts === null
          ? "Loading live alerts"
          : alerted.length
            ? null
            : "No recent live alerts",
    },
  );
  const sectors = new Map<string, string[]>();
  for (const t of watchlist.tickers) {
    const etf = watchlist.benchmarks[t];
    if (etf && etf !== t) sectors.set(etf, [...(sectors.get(etf) ?? []), t]);
  }
  for (const [etf, tickers] of [...sectors].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  ))
    presets.push({
      key: `sector:${etf}`,
      label: etf,
      tickers: tickers.slice(0, maxTickers),
      disabled: null,
    });
  return presets;
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((t) => b.includes(t));

/** The preset whose symbols equal the selection, if any. */
export function selectedPreset(
  presets: SymbolPreset[],
  selected: string[],
): string | null {
  return (
    presets.find(
      (p) => !p.disabled && p.tickers.length && sameSet(p.tickers, selected),
    )?.key ?? null
  );
}

/** "NVDA, AMD, TSLA +22 more". */
export function previewTickers(tickers: string[], shown = 8): string {
  if (!tickers.length) return "No symbols selected";
  const rest = tickers.length - shown;
  return (
    tickers.slice(0, shown).join(", ") + (rest > 0 ? ` +${rest} more` : "")
  );
}

// ------------------------------------------------------------------- dates

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * The newest US session whose extended hours (to 20:00 New York) have ended
 * at `now`. Throws outside the published calendar.
 */
export function lastCompleteSession(now: number): string {
  const today = newYork(now).date;
  if (coreClose(today) !== null && now >= newYorkToUtc(today, 1200))
    return today;
  return previousSessions(today, 1)[0]!;
}

/** The last `count` complete US sessions; null outside the calendar. */
export function lastSessions(
  count: number,
  now: number,
): { from: string; to: string } | null {
  try {
    const to = lastCompleteSession(now);
    return { from: previousSessions(addDays(to, 1), count)[0]!, to };
  } catch {
    return null;
  }
}

/** US sessions from `from` to `to` inclusive; null outside the calendar. */
export function sessionCount(from: string, to: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
    return null;
  if (from > to) return 0;
  let n = 0;
  try {
    for (let d = from; d <= to; d = addDays(d, 1))
      if (coreClose(d) !== null) n++;
  } catch {
    return null;
  }
  return n;
}

export const datePresetCounts = [5, 10, 20] as const;

/** Which "Last N sessions" preset the range equals, else "custom". */
export function datePreset(
  from: string,
  to: string,
  now: number,
): number | "custom" {
  for (const n of datePresetCounts) {
    const r = lastSessions(n, now);
    if (r && r.from === from && r.to === to) return n;
  }
  return "custom";
}

const dateLabel = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** US session dates as "Fri 25 Sep – Fri 2 Oct" (date-only labels). */
export function rangeLabel(from: string, to: string): string {
  const f = (d: string) => dateLabel.format(Date.parse(`${d}T12:00:00Z`));
  return from === to ? f(from) : `${f(from)} – ${f(to)}`;
}

// ----------------------------------------------------------------- verdict

export type Tone = "better" | "worse" | "neutral";

export interface VerdictRow {
  key: "good" | "stopped" | "weak";
  alerts: number | null; // rounded percent
  baseline: number | null; // the baseline entries' rounded percent
  diff: number | null; // percentage points (from the rounded percents)
  tone: Tone;
}

const percent = (n: number, d: number) =>
  d ? Math.round((n / d) * 100) : null;

/** Good, stopped and weak shares for alerts vs the baseline entries. */
export function verdictRows(s: ValidationSummary): VerdictRow[] {
  return (["good", "stopped", "weak"] as const).map((key) => {
    const alerts = percent(s[key], s.scored);
    const baseline = percent(s.baseline[key], s.baseline.scored);
    const diff =
      alerts === null || baseline === null ? null : alerts - baseline;
    const tone: Tone =
      diff === null || diff === 0 || key === "weak"
        ? "neutral"
        : (key === "good" ? diff > 0 : diff < 0)
          ? "better"
          : "worse";
    return { key, alerts, baseline, diff, tone };
  });
}

/** "+2 pts" / "−3 pts" / "0 pts". */
export const signedPoints = (n: number) =>
  `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)} pts`;

/** "+0.12%" / "−0.40%" / "0.00%" (no sign when it rounds to zero). */
export function signedPercent(n: number | null, digits = 2): string {
  if (n === null) return "—";
  const r = Number(n.toFixed(digits));
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(digits)}%`;
}

/** Sign of a value as displayed: 1, −1 or 0 when it rounds to zero. */
export const shownSign = (n: number, digits = 2) =>
  Math.sign(Number(n.toFixed(digits)));

/** Scored alerts below which the verdict warns about noise. */
export const minTrusted = 50;

/** Unscored reasons with counts, most common first. */
export function unscoredReasons(
  alerts: { outcome: { result: string; reason?: string } }[],
): [string, number][] {
  const counts = new Map<string, number>();
  for (const a of alerts)
    if (a.outcome.result === "unscored") {
      const r = a.outcome.reason ?? "unknown";
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

// ------------------------------------------------------------- alerts tab

// The look-now score is the primary grade (docs/features/look-now-score.md);
// older APIs may omit it, which counts as unscored here.
type Looked = { lookNow?: Pick<LookNow, "score" | "label"> };

export type LookFilter = "all" | LookNowLabel | "unscored";

const lookKey = (a: Looked): Exclude<LookFilter, "all"> =>
  a.lookNow?.score === null || a.lookNow?.score === undefined
    ? "unscored"
    : (a.lookNow.label ?? "unscored");

export function lookCounts<T extends Looked & { ticker: string }>(
  alerts: T[],
  symbol: string | null,
): Record<LookFilter, number> {
  const rows = alerts.filter((a) => !symbol || a.ticker === symbol);
  const n = (k: LookFilter) => rows.filter((a) => lookKey(a) === k).length;
  return {
    all: rows.length,
    "very-big": n("very-big"),
    big: n("big"),
    normal: n("normal"),
    unscored: n("unscored"),
  };
}

export function filterLook<T extends Looked>(
  alerts: T[],
  filter: LookFilter,
): T[] {
  return filter === "all"
    ? alerts
    : alerts.filter((a) => lookKey(a) === filter);
}

/** Mean look-now score of the scored alerts, or null. */
export function averageScore(rows: Looked[]): number | null {
  const scores = rows
    .map((a) => a.lookNow?.score)
    .filter((x): x is number => x !== null && x !== undefined);
  return scores.length
    ? scores.reduce((n, x) => n + x, 0) / scores.length
    : null;
}

/** "14 alerts · avg score 71". */
export function dayScoreLabel(rows: Looked[]): string {
  const avg = averageScore(rows);
  return (
    `${rows.length} ${rows.length === 1 ? "alert" : "alerts"}` +
    (avg === null ? "" : ` · avg score ${Math.round(avg)}`)
  );
}

/** "Peak 15 min · with burst" / "Peak close · against burst" / "—". */
export function peakLabel(
  look: Pick<LookNow, "score" | "peak" | "withBurst"> | undefined,
): string {
  if (!look || look.score === null || look.peak === null) return "—";
  const at = look.peak === "close" ? "close" : `${look.peak} min`;
  return (
    `Peak ${at}` +
    (look.withBurst === null
      ? ""
      : look.withBurst
        ? " · with burst"
        : " · against burst")
  );
}

// ---------------------------------------------------------- by-symbol tab

export type { BaselineCounts };

export interface SymbolRow {
  ticker: string;
  alerts: number;
  scored: number;
  good: number;
  weak: number;
  stopped: number;
  lookScored: number; // alerts with a look-now score
  avgScore: number | null; // mean look-now score
  bigShare: number | null; // rounded % of scored alerts labelled Big or Very big
  goodPct: number | null; // trade view, rounded
  vsBaseline: number | null; // trade view: points vs the symbol's own baseline
  small: boolean; // fewer than `minSymbolAlerts` look-now-scored alerts
}

export const minSymbolAlerts = 5;

/** One row per symbol with alerts, from the alerts' outcomes. */
export function symbolRows(
  alerts: BacktestAlert[],
  baselines?: Record<string, BaselineCounts>,
): SymbolRow[] {
  const by = new Map<string, BacktestAlert[]>();
  for (const a of alerts) by.set(a.ticker, [...(by.get(a.ticker) ?? []), a]);
  return [...by].map(([ticker, rows]) => {
    const scored = rows.filter((a) => a.outcome.result !== "unscored");
    const n = (r: string) =>
      scored.filter((a) => a.outcome.result === r).length;
    const good = n("good");
    const goodPct = percent(good, scored.length);
    const lookScored = rows.filter(
      (a) => a.lookNow?.score !== null && a.lookNow?.score !== undefined,
    ).length;
    const base = baselines?.[ticker];
    const baseGood = base ? percent(base.good, base.scored) : null;
    return {
      ticker,
      alerts: rows.length,
      scored: scored.length,
      good,
      weak: n("weak"),
      stopped: n("stopped"),
      goodPct,
      vsBaseline:
        goodPct === null || baseGood === null ? null : goodPct - baseGood,
      lookScored,
      avgScore: averageScore(rows),
      bigShare: percent(
        rows.filter(
          (a) => a.lookNow?.label === "big" || a.lookNow?.label === "very-big",
        ).length,
        lookScored,
      ),
      small: lookScored < minSymbolAlerts,
    };
  });
}

export type SymbolSort =
  "ticker" | "alerts" | "avgScore" | "bigShare" | "goodPct" | "vsBaseline";

const symbolValue: Record<
  SymbolSort,
  (r: SymbolRow) => number | string | null
> = {
  ticker: (r) => r.ticker,
  alerts: (r) => r.alerts,
  avgScore: (r) => r.avgScore,
  bigShare: (r) => r.bigShare,
  goodPct: (r) => r.goodPct,
  vsBaseline: (r) => r.vsBaseline,
};

/**
 * Sorts by a column; rows with too few scored alerts always come after the
 * rest, and missing values ("—") last within each part. Ties by alerts, then
 * symbol.
 */
export function sortSymbolRows(
  rows: SymbolRow[],
  key: SymbolSort,
  descending: boolean,
): SymbolRow[] {
  const value = symbolValue[key];
  return [...rows].sort((a, b) => {
    if (a.small !== b.small) return a.small ? 1 : -1;
    const va = value(a);
    const vb = value(b);
    let c = 0;
    if (va === null || vb === null) c = va === vb ? 0 : va === null ? 1 : -1;
    else c = (va < vb ? -1 : va > vb ? 1 : 0) * (descending ? -1 : 1);
    return c || b.alerts - a.alerts || (a.ticker < b.ticker ? -1 : 1);
  });
}

// ----------------------------------------------------------- data quality

export interface FailedBatch {
  tickers: string[];
  error: string;
}

/** Tab count: "OK", "1 gap", "2 failed" or "3 issues". */
export function qualityLabel(
  result: Pick<BacktestResult, "coverage"> | null,
  failed: FailedBatch[],
): string {
  const gaps =
    result?.coverage.filter((c) => c.missingSessions.length).length ?? 0;
  const fails = failed.length;
  if (gaps && fails) return `${gaps + fails} issues`;
  if (gaps) return `${gaps} ${gaps === 1 ? "gap" : "gaps"}`;
  if (fails) return `${fails} failed`;
  return "OK";
}

const diagnosticLabels: Record<string, string> = {
  "below-threshold": "Volume below threshold",
  "insufficient-history": "Not enough history",
  "weak-last-bar": "Last minute moved too little",
  "zero-baseline": "No typical volume",
  "low-volume": "Below minimum volume",
  "mixed-direction": "Candles in mixed directions",
  "small-move": "Move too small",
  "busy-day-volume": "Burst small for today's volume",
  "normal-for-today": "Move normal for today",
  suppressed: "Cooldown or still elevated",
  alert: "Alerted",
};

export interface DiagnosticBar {
  key: string;
  label: string;
  count: number;
  width: number; // percent of the largest, log scale
}

/** Diagnostics, largest first, with log-scale bar widths. */
export function diagnosticBars(
  diagnostics: Record<string, number>,
): DiagnosticBar[] {
  const entries = Object.entries(diagnostics)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const max = Math.log10((entries[0]?.[1] ?? 1) + 1);
  return entries.map(([key, count]) => ({
    key,
    label: diagnosticLabels[key] ?? key.replaceAll("-", " "),
    count,
    width: max > 0 ? Math.max(2, (Math.log10(count + 1) / max) * 100) : 0,
  }));
}

// ----------------------------------------------------------- run requests

export interface RunRequest {
  tickers: string[];
  from: string;
  to: string;
  config: RuleSettings;
  validation: Pick<ValidationConfig, "stopUnits" | "goodUnits" | "horizon">;
}

/** Identity of a run's inputs, to tell when settings changed after a run. */
export const requestKey = (r: RunRequest) =>
  JSON.stringify([
    [...r.tickers].sort(),
    r.from,
    r.to,
    ruleKeys.map((k) => r.config[k]),
    [r.validation.stopUnits, r.validation.goodUnits, r.validation.horizon],
  ]);

/** Symbols per request for a range of `sessions`, within the Worker's memory. */
export const symbolsPerBatch = (sessions: number) =>
  Math.max(1, maxSymbolsPerRequest(sessions, defaults.days));

export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/** "Setup · 30 symbols · 5 sessions · rvol-v4 + 1 change". */
export function setupSummary(
  symbols: number,
  sessions: number | null,
  changes: number,
): string {
  return [
    "Setup",
    `${symbols} ${symbols === 1 ? "symbol" : "symbols"}`,
    sessions === null
      ? "dates outside the calendar"
      : `${sessions} ${sessions === 1 ? "session" : "sessions"}`,
    ruleLabel(changes),
  ].join(" · ");
}

// ------------------------------------------------------------ batch merge

const addCounts = (a: BaselineCounts, b: BaselineCounts): BaselineCounts => ({
  scored: a.scored + b.scored,
  good: a.good + b.good,
  stopped: a.stopped + b.stopped,
  weak: a.weak + b.weak,
});

/**
 * Combines batch results (or a previous result and retried batches). Medians
 * cannot be combined across batches, so the summary is recomputed from all
 * alerts; baseline counts, per-symbol baselines, diagnostics and cache stats
 * add up. A symbol present in a later part replaces its earlier data.
 */
export function mergeResults(parts: BacktestResult[]): BacktestResult {
  const [first] = parts;
  if (!first) throw new Error("Nothing to merge");
  const alerts = parts.flatMap((p) => p.alerts);
  const validation: ValidationSummary = summarize(
    alerts.map((a) => a.outcome),
    [],
    first.validation.config,
  );
  for (const p of parts)
    validation.baseline = addCounts(validation.baseline, p.validation.baseline);
  // Batches cover different symbols; an older API omits the map.
  if (parts.some((p) => p.validation.baselineBySymbol))
    validation.baselineBySymbol = Object.assign(
      {},
      ...parts.map((p) => p.validation.baselineBySymbol ?? {}),
    ) as Record<string, BaselineCounts>;
  const lookNow = mergeLookNow(parts, alerts);
  const diagnostics: Record<string, number> = {};
  for (const p of parts)
    for (const [k, n] of Object.entries(p.diagnostics))
      diagnostics[k] = (diagnostics[k] ?? 0) + n;
  return {
    ...first,
    tickers: [...new Set(parts.flatMap((p) => p.tickers))],
    evaluated: parts.reduce((n, p) => n + p.evaluated, 0),
    alerts,
    diagnostics,
    validation,
    ...(lookNow ? { lookNow } : {}),
    cache: parts.some((p) => p.cache)
      ? {
          hits: parts.reduce((n, p) => n + (p.cache?.hits ?? 0), 0),
          misses: parts.reduce((n, p) => n + (p.cache?.misses ?? 0), 0),
          errors: parts.reduce((n, p) => n + (p.cache?.errors ?? 0), 0),
          lastError: parts.findLast((p) => p.cache?.lastError)?.cache
            ?.lastError,
        }
      : undefined,
    coverage: parts.flatMap((p) => p.coverage),
  };
}

/**
 * Look-now summary of merged batches: alert statistics from all alerts; each
 * batch ranked against its own random minutes, so the baselines combine by
 * weighted average (docs/features/look-now-score.md). Undefined when no part
 * has one (older API).
 */
function mergeLookNow(
  parts: BacktestResult[],
  alerts: BacktestAlert[],
): LookNowSummary | undefined {
  const bases = parts
    .map((p) => (p.lookNow as LookNowSummary | undefined)?.baseline)
    .filter((b) => b !== undefined);
  if (!bases.length) return undefined;
  const own = summarizeLookNow(
    alerts.map((a) => a.lookNow).filter((l) => l !== undefined),
    [],
  );
  const scored = bases.reduce((n, b) => n + b.scored, 0);
  return {
    ...own,
    baseline: {
      scored,
      averageScore: scored
        ? bases.reduce((n, b) => n + (b.averageScore ?? 0) * b.scored, 0) /
          scored
        : null,
      big: bases.reduce((n, b) => n + b.big, 0),
      veryBig: bases.reduce((n, b) => n + b.veryBig, 0),
    },
  };
}

/** Server messages that mean the settings are invalid for every batch. */
export const isSettingsError = (message: string) =>
  /^(Choose|Dates|The range|Invalid)/.test(message);
