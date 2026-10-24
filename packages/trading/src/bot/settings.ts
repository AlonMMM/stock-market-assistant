import { defaultExitRules, type ExitRules } from "./exits.js";
import { defaultPickRules, type PickRules } from "./picker.js";
import { defaultSignalParams, type SignalParams } from "./signal.js";
import {
  currentVersion,
  matchingVersion,
  versionLabelPattern,
} from "./versions.js";

// The bot's settings (docs/tasks/backend-bot-settings.md): what the owner can
// change on the site's Bot settings page. The defaults are the backtested
// rules (docs/tasks/backend-indi-bot.md) plus four limits the backtest did not
// have. The trading service stores what the owner saved and fills the rest
// from these defaults, so a new field never needs a migration.

export interface BotSettings {
  enabled: boolean;
  mode: "live" | "dry";
  // The version of the rules the bot runs (versions.ts): a known version's id
  // ("2.1") or the owner's own label for a rule set. Every entry is stamped
  // with it, with a star when the rules were changed from the version's.
  version: string;
  // Stocks: the core list and the favorites list, plus the owner's own.
  followFavorites: boolean;
  added: string[];
  off: string[];
  // Trade size
  sizePct: number;
  maxBuysPerDay: number;
  maxOpen: number;
  // Losses
  stopPct: number;
  safetyStopPct: number;
  dayLossPct: number;
  drawdownPausePct: number;
  checks: boolean;
  // On the entry day, sell all when the signal's own t-stat vs SPY × beta
  // (cumulative from the open) falls to weaknessT or under: the stock gave
  // back its edge over the market (the 2026-10-24 champion).
  sellOnWeakness: boolean;
  weaknessT: number;
  // On the entry day, sell all when the stock reaches the next level ahead
  // and falls back without breaking it (levels.ts).
  sellFailedBreak: boolean;
  // Profits and holding
  holdFromPct: number;
  maxNights: number;
  // At 15:50, what one contract holds overnight is worth at most this % of
  // the account; the excess is sold first. 0 = no cap.
  nightCapPct: number;
  // Contract
  delta: number;
  maxDte: number;
  minPrice: number;
  minVolume: number;
  // Signal (advanced)
  minT: number;
  minRvol: number;
  firstEntryMin: number;
  skipEarnings: boolean;
  skipPremarket: boolean;
}

export type NumberKey = {
  [K in keyof BotSettings]: BotSettings[K] extends number ? K : never;
}[keyof BotSettings];
type BooleanKey = {
  [K in keyof BotSettings]: BotSettings[K] extends boolean ? K : never;
}[keyof BotSettings];

// The index ETFs start off: the backtest left them out.
export const defaultSettings: BotSettings = {
  enabled: true,
  mode: "live",
  version: currentVersion,
  followFavorites: true,
  added: [],
  off: ["QQQ", "SQQQ"],
  sizePct: 2,
  maxBuysPerDay: 5,
  maxOpen: 4,
  stopPct: 30,
  safetyStopPct: 50,
  dayLossPct: 5,
  drawdownPausePct: 15,
  checks: true,
  sellOnWeakness: true,
  weaknessT: 0.5,
  sellFailedBreak: true,
  holdFromPct: 50,
  maxNights: 2,
  nightCapPct: 10,
  delta: 0.15,
  maxDte: 7,
  minPrice: 0.2,
  minVolume: 200,
  minT: 1.8,
  minRvol: 1.5,
  firstEntryMin: 10,
  skipEarnings: true,
  skipPremarket: true,
};

// Values the backtest never ran.
export const untested: ReadonlySet<keyof BotSettings> = new Set([
  "maxBuysPerDay",
  "maxOpen",
  "safetyStopPct",
  "dayLossPct",
  "drawdownPausePct",
]);

// SPY is the benchmark; the futures have no options the bot buys.
export const neverWatched = ["SPY", "CL", "GC", "SI"];

// What each number may be, with its step (the page's sliders). Delta stays at
// or under 0.25 (user 2026-10-21).
export const limits: Record<
  NumberKey,
  [min: number, max: number, step: number]
> = {
  sizePct: [0.5, 5, 0.5],
  maxBuysPerDay: [1, 10, 1],
  maxOpen: [1, 10, 1],
  stopPct: [15, 60, 5],
  weaknessT: [0, 1.5, 0.1],
  safetyStopPct: [30, 80, 5],
  dayLossPct: [1, 10, 0.5],
  drawdownPausePct: [5, 40, 5],
  holdFromPct: [50, 300, 25],
  maxNights: [0, 3, 1],
  nightCapPct: [0, 25, 1],
  delta: [0.05, 0.25, 0.05],
  maxDte: [1, 14, 1],
  minPrice: [0.05, 1, 0.05],
  minVolume: [0, 1000, 50],
  minT: [1, 4, 0.1],
  minRvol: [1, 3, 0.1],
  firstEntryMin: [5, 60, 5],
};

const booleans: BooleanKey[] = [
  "enabled",
  "followFavorites",
  "checks",
  "sellOnWeakness",
  "sellFailedBreak",
  "skipEarnings",
  "skipPremarket",
];
const ticker = /^[A-Z][A-Z.]{0,5}$/;
const maxTickers = 200;

/**
 * Saved values over the defaults; anything not valid falls back. A record
 * saved before versions gets the version its rules match, else the current.
 */
export function withDefaults(
  saved: unknown,
  base: BotSettings = defaultSettings,
): BotSettings {
  const record = isObject(saved) ? saved : {};
  const merged = { ...base, ...record };
  if (!("version" in record))
    merged.version = matchingVersion(merged)?.id ?? currentVersion;
  const checked = parseSettings(merged);
  return checked.ok ? checked.value : base;
}

/** A whole settings object from a request, or what is wrong with it. */
export function parseSettings(
  body: unknown,
): { ok: true; value: BotSettings } | { ok: false; error: string } {
  if (!isObject(body)) return { ok: false, error: "Expected a JSON object" };
  const out = { ...defaultSettings };
  for (const key of booleans) {
    const v = body[key];
    if (typeof v !== "boolean")
      return { ok: false, error: `${key} must be true or false` };
    out[key] = v;
  }
  if (body.mode !== "live" && body.mode !== "dry")
    return { ok: false, error: "mode must be live or dry" };
  out.mode = body.mode;
  const version = typeof body.version === "string" ? body.version.trim() : "";
  if (!versionLabelPattern.test(version))
    return {
      ok: false,
      error:
        "version must be a known version or a label of up to 24 letters, digits, dots and dashes",
    };
  out.version = version;
  for (const [key, [min, max, step]] of Object.entries(limits) as [
    NumberKey,
    [number, number, number],
  ][]) {
    const v = body[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
      return {
        ok: false,
        error: `${key} must be a number from ${min} to ${max}`,
      };
    // On the step, without floating-point dust.
    out[key] = Number((Math.round(v / step) * step).toFixed(4));
  }
  for (const key of ["added", "off"] as const) {
    const v = body[key];
    if (!Array.isArray(v) || v.length > maxTickers)
      return { ok: false, error: `${key} must be a list of tickers` };
    const list: string[] = [];
    for (const t of v) {
      const up = typeof t === "string" ? t.trim().toUpperCase() : "";
      if (!ticker.test(up))
        return { ok: false, error: `${key} has a bad ticker: ${String(t)}` };
      if (!list.includes(up)) list.push(up);
    }
    out[key] = list;
  }
  out.added = out.added.filter((t) => !neverWatched.includes(t));
  return { ok: true, value: out };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The stocks to watch: core, the owner's, the favorites if followed, less those off. */
export function watchedStocks(
  s: BotSettings,
  core: readonly string[],
  favorites: readonly string[],
): string[] {
  const all = [...core, ...s.added, ...(s.followFavorites ? favorites : [])];
  return [...new Set(all)].filter(
    (t) => !s.off.includes(t) && !neverWatched.includes(t),
  );
}

export const signalParams = (s: BotSettings): SignalParams => ({
  ...defaultSignalParams,
  firstMinute: s.firstEntryMin,
  strengthT: s.minT,
  rvolDay: s.minRvol,
});

export const pickRules = (s: BotSettings): PickRules => ({
  ...defaultPickRules,
  delta: s.delta,
  dteMax: s.maxDte,
  minPrice: s.minPrice,
  minVolume30: s.minVolume,
});

export function exitRules(s: BotSettings): ExitRules {
  let checks = defaultExitRules.checks;
  if (!s.checks) checks = [];
  return {
    ...defaultExitRules,
    checks,
    stopOut: -s.stopPct / 100,
    strengthOut: s.sellOnWeakness ? s.weaknessT : null,
    carryMinGain: s.holdFromPct / 100,
    carryMaxNights: s.maxNights,
  };
}

/**
 * The bot's drawdown: how far its realized P&L (dollars, in order of the
 * sales) is below its best, starting from zero.
 */
export function drawdown(pnls: readonly number[]): number {
  let total = 0;
  let best = 0;
  for (const p of pnls) {
    total += p;
    best = Math.max(best, total);
  }
  return best - total;
}
