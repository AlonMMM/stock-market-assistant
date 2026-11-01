import { defaultExitRules, type ExitRules } from "./exits.js";
import { defaultPickRules, type PickRules } from "./picker.js";
import { defaultSignalParams, type SignalParams } from "./signal.js";
import {
  botVersions,
  currentVersion,
  matchingVersion,
  ruleKeys,
  versionById,
  versionLabelPattern,
} from "./versions.js";

// The bot's settings (docs/tasks/backend-bot-settings.md): what the owner can
// change on the site's Bot settings page. The defaults are the backtested
// rules (docs/tasks/backend-indi-bot.md) plus four limits the backtest did not
// have. The trading service stores what the owner saved and fills the rest
// from these defaults, so a new field never needs a migration.

// The brokers the bot can trade at (user 2026-10-24: "configurable in the bot
// settings, to trade via ibkr or alpaca account"). The trading service says
// which are connected; a position keeps the broker it was bought at.
export type BotBroker = "alpaca" | "ibkr";
export const botBrokers: readonly BotBroker[] = ["alpaca", "ibkr"];
export const brokerNames: Record<BotBroker, string> = {
  alpaca: "Alpaca",
  ibkr: "Interactive Brokers",
};
// The owner's choice: one broker, or both at once, every signal bought at
// each (user 2026-10-24: "trade in both in parallel, to see the difference in
// premia and rake").
export type BotBrokerChoice = BotBroker | "both";
export const botBrokerChoices: readonly BotBrokerChoice[] = [
  "alpaca",
  "ibkr",
  "both",
];

/** The brokers a choice buys at, among the connected ones. */
export function entryBrokers(
  choice: BotBrokerChoice,
  connected: readonly BotBroker[],
): BotBroker[] {
  if (choice === "both") return botBrokers.filter((b) => connected.includes(b));
  return connected.includes(choice) ? [choice] : [];
}

export interface BotSettings {
  enabled: boolean;
  mode: "live" | "dry";
  // Where new entries are bought: the owner's IBKR paper account, the bot's
  // Alpaca account, or both. Open positions stay with their own broker.
  broker: BotBrokerChoice;
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
  // The size steps down as the account grows (version 2.8.1; the owner,
  // 2026-10-31: "3% until 300K -> 2.5 until 1M, 1.5 at 1M and 1 at 4M"): from
  // each step's account value on (the account as the day starts), `pct`
  // instead of sizePct. A version rule (versions.ts), not an owner limit.
  sizeSteps: SizeStep[];
  maxBuysPerDay: number;
  maxOpen: number;
  // Losses
  stopPct: number;
  // Once the 10-minute check sold half, the rest's stop on the entry day
  // (with the stock against); 0 = off, the rest keeps `stopPct` (version 2.4).
  restStopPct: number;
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
  // Under minPrice, the cheapest strike toward the money at minPrice or more
  // (version 2.6; picker.ts).
  cheapFallback: boolean;
  // Signal (advanced)
  minT: number;
  // The D2 bonus (version 2.5): t d2T or more also enters when the stock held
  // up on SPY's bad minutes of the last 30, D2 minD2 or more (signal.ts).
  d2Entry: boolean;
  d2T: number;
  minD2: number;
  minRvol: number;
  firstEntryMin: number;
  skipEarnings: boolean;
  skipPremarket: boolean;
  // Stocks whose option may cost as little as lowFloorPrice (version 2.7: IBIT
  // at $0.10); every other stock keeps minPrice.
  lowFloorSymbols: string[];
  lowFloorPrice: number;
  // The pyramid (version 2.7): after a D2 bonus entry, one more position of
  // pyramidSharePct of the size, in a fresh pick, when the stock first reaches
  // the full signal that day on the same side while the first position is
  // still held and above its cost.
  pyramid: boolean;
  pyramidSharePct: number;
  // Early entry (version 2.7): the signal is checked on every tick inside the
  // minute, on the stocks' and SPY's latest trades, and bought at the first
  // check it holds, not when the minute closes.
  earlyEntry: boolean;
  // The staged stock exit (version 2.8): on the entry day, half is sold once
  // the stock is stageHalfS30 of its usual 30-minute move (S30) against the
  // price at the signal, the rest at stageFullS30 against.
  stockStages: boolean;
  stageHalfS30: number;
  stageFullS30: number;
  // An entry at 15:00 or later is not sold on its entry day while above its
  // cost, up to the 15:50 decision (version 2.8).
  lateHold: boolean;
  // The break-even lock (version 2.9): on the entry day, once the option is
  // lockArmPct over its cost, sell all when the stock gets back to the price
  // where the option would be worth its cost (worked out again each minute it
  // is still that far up, the tighter level kept).
  breakEvenLock: boolean;
  lockArmPct: number;
}

export interface SizeStep {
  from: number; // account value, dollars
  pct: number; // of the account, per trade
}

/** The size of a trade for an account value: sizePct, or the last step at or under the value. */
export function sizeAt(
  sizePct: number,
  steps: readonly SizeStep[],
  account: number,
): number {
  // An unknown account (0: the read failed) takes the smallest size the steps
  // allow, never the largest.
  if (!(account > 0) && steps.length)
    return Math.min(sizePct, ...steps.map((x) => x.pct));
  // A step only ever lowers the owner's size: from 2%, "2.5% from $300K" keeps 2%.
  let pct = sizePct;
  for (const step of steps)
    if (account >= step.from) pct = Math.min(sizePct, step.pct);
  return pct;
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
  broker: "alpaca",
  version: currentVersion,
  followFavorites: true,
  added: [],
  off: ["QQQ", "SQQQ"],
  sizePct: 3,
  sizeSteps: [
    { from: 300_000, pct: 2.5 },
    { from: 1_000_000, pct: 1.5 },
    { from: 4_000_000, pct: 1 },
  ],
  maxBuysPerDay: 5,
  maxOpen: 4,
  stopPct: 60,
  restStopPct: 20,
  // Above the stop (-60% since version 2.8), or the broker's stop fires first.
  safetyStopPct: 65,
  dayLossPct: 5,
  drawdownPausePct: 15,
  checks: false,
  sellOnWeakness: true,
  weaknessT: 0.5,
  sellFailedBreak: false,
  holdFromPct: 50,
  maxNights: 2,
  nightCapPct: 10,
  delta: 0.15,
  maxDte: 7,
  minPrice: 0.2,
  minVolume: 200,
  cheapFallback: false,
  minT: 1.8,
  d2Entry: true,
  d2T: 1.2,
  minD2: 1.5,
  minRvol: 1.5,
  firstEntryMin: 10,
  skipEarnings: true,
  skipPremarket: true,
  lowFloorSymbols: ["IBIT"],
  lowFloorPrice: 0.1,
  pyramid: true,
  pyramidSharePct: 50,
  earlyEntry: true,
  stockStages: true,
  stageHalfS30: 0.5,
  stageFullS30: 1,
  lateHold: true,
  breakEvenLock: true,
  lockArmPct: 50,
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
  stopPct: [15, 70, 5],
  restStopPct: [0, 50, 5],
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
  d2T: [1, 1.8, 0.1],
  minD2: [0.5, 3, 0.1],
  minRvol: [1, 3, 0.1],
  firstEntryMin: [5, 60, 5],
  lowFloorPrice: [0.05, 1, 0.05],
  pyramidSharePct: [25, 100, 25],
  stageHalfS30: [0.25, 2, 0.25],
  stageFullS30: [0.5, 3, 0.25],
  lockArmPct: [20, 200, 10],
};

const booleans: BooleanKey[] = [
  "enabled",
  "followFavorites",
  "checks",
  "sellOnWeakness",
  "sellFailedBreak",
  "cheapFallback",
  "d2Entry",
  "skipEarnings",
  "skipPremarket",
  "pyramid",
  "earlyEntry",
  "stockStages",
  "lateHold",
  "breakEvenLock",
];
const ticker = /^[A-Z][A-Z.]{0,5}$/;
const maxTickers = 200;

/**
 * Saved values over the defaults; anything not valid falls back. A record
 * saved before versions gets the version its rules match, else the current.
 * A rule saved before it existed takes its saved version's value, so a new
 * rule never changes a running version (2.3 stays 2.3 until 2.4 is chosen).
 */
export function withDefaults(
  saved: unknown,
  base: BotSettings = defaultSettings,
): BotSettings {
  const record = isObject(saved) ? saved : {};
  const merged: Record<string, unknown> = { ...base, ...record };
  const known =
    typeof record.version === "string"
      ? versionById(record.version)
      : undefined;
  if (known) {
    for (const key of ruleKeys)
      if (!(key in record)) merged[key] = known.rules[key];
    merged.version = known.id; // "2.7" saved before MAJOR.MINOR.PATCH -> "2.7.0"
  }
  if (!known && typeof record.version === "string") {
    // An own label saved before a rule existed: the rule as it was then, off
    // (1.0's value), never the current version's.
    const before = botVersions[0]!.rules;
    for (const key of ruleKeys) if (!(key in record)) merged[key] = before[key];
  }
  if (!("version" in record)) {
    // A record from before versions: its missing rules are 2.6's (the rules
    // added since, like the pyramid and early entry, did not exist for it).
    const legacy = versionById("2.6.0")!.rules;
    for (const key of ruleKeys) if (!(key in record)) merged[key] = legacy[key];
    merged.version =
      matchingVersion(merged as unknown as BotSettings)?.id ?? currentVersion;
  }
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
  if (!(botBrokerChoices as readonly unknown[]).includes(body.broker))
    return { ok: false, error: "broker must be alpaca, ibkr or both" };
  out.broker = body.broker as BotBrokerChoice;
  const version = typeof body.version === "string" ? body.version.trim() : "";
  if (!versionLabelPattern.test(version))
    return {
      ok: false,
      error:
        "version must be a known version or a label of up to 24 letters, digits, dots and dashes",
    };
  out.version = versionById(version)?.id ?? version; // a known id before MAJOR.MINOR.PATCH ("2.6") -> "2.6.0"
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
  for (const key of ["added", "off", "lowFloorSymbols"] as const) {
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
  const steps = parseSizeSteps(body.sizeSteps);
  if (steps === null)
    return {
      ok: false,
      error:
        "sizeSteps must be up to 6 steps of { from: dollars, rising, pct: 0.5 to 5 }",
    };
  out.sizeSteps = steps;
  return { ok: true, value: out };
}

/** Size steps from a request: rising account values, each size within the size's limits; null when wrong. */
function parseSizeSteps(v: unknown): SizeStep[] | null {
  if (!Array.isArray(v) || v.length > 6) return null;
  const [min, max] = limits.sizePct;
  const out: SizeStep[] = [];
  for (const x of v) {
    if (!isObject(x)) return null;
    const { from, pct } = x;
    if (typeof from !== "number" || !Number.isFinite(from) || from <= 0)
      return null;
    if (typeof pct !== "number" || pct < min || pct > max) return null;
    if (out.length && from <= out.at(-1)!.from) return null;
    out.push({ from, pct });
  }
  return out;
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
  bonusT: s.d2Entry ? s.d2T : null,
  bonusD2: s.minD2,
});

/** The lowest option price a stock may be bought at: its own when listed (2.7: IBIT $0.10). */
export const minPriceFor = (s: BotSettings, symbol: string): number =>
  s.lowFloorSymbols.includes(symbol) ? s.lowFloorPrice : s.minPrice;

/** The contract rules for one stock (the floor is the stock's own). */
export const pickRules = (s: BotSettings, symbol?: string): PickRules => ({
  ...defaultPickRules,
  delta: s.delta,
  dteMax: s.maxDte,
  minPrice: symbol === undefined ? s.minPrice : minPriceFor(s, symbol),
  minVolume30: s.minVolume,
  cheapFallback: s.cheapFallback,
});

/** The rest's stop after the 10-minute half, as an option return; null when off. */
function restStop(s: BotSettings): number | null {
  if (s.restStopPct <= 0) return null;
  return -s.restStopPct / 100;
}

/** 15:00 New York: an entry from here is held while above its cost (lateHold). */
export const lateHoldMinute = 330;

export function exitRules(s: BotSettings): ExitRules {
  let checks = defaultExitRules.checks;
  if (!s.checks) checks = [];
  return {
    ...defaultExitRules,
    checks,
    stopOut: -s.stopPct / 100,
    restStopOut: restStop(s),
    stages: s.stockStages
      ? { half: s.stageHalfS30, full: s.stageFullS30 }
      : null,
    lateHoldFrom: s.lateHold ? lateHoldMinute : null,
    lock: s.breakEvenLock ? { arm: s.lockArmPct / 100 } : null,
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
