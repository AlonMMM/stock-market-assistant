import type { BotSettings } from "./settings.js";

// The bot's versions (docs/tasks/backend-bot-settings.md, "Versions"): each
// is a named set of the trading rules, the settings that decide when the bot
// enters, what it buys and how it exits. The owner picks the version the bot
// runs on the settings page; every signal and position is stamped with the
// version in force when it was entered, so results can be read per version.
// The owner's own limits (size, buys a day, open positions, the daily loss,
// the drawdown pause, the broker safety stop) and the stock lists are not part
// of a version.
//
// Numbering, MAJOR.MINOR.PATCH (the owner, 2026-10-28):
//   MAJOR  the core strategy is redefined (the entry signal family, the
//          instrument, the exit framework, how a trade is sized) and
//          re-backtested from scratch; a code change, never a settings edit
//   MINOR  a core setting's value changes, or a rule is added, removed or
//          switched on / off (`minorKeys`, and restStopPct / nightCapPct
//          crossing 0)
//   PATCH  a rule's own numbers change (every other rule key)
// The owner's limits never change the number; a version run with changed rules
// is stamped with a star ("2.7.0*"). Ids before the scheme ("2.6") read as
// "2.6.0".

export type RuleKey =
  | "stopPct"
  | "restStopPct"
  | "checks"
  | "sellOnWeakness"
  | "weaknessT"
  | "sellFailedBreak"
  | "holdFromPct"
  | "maxNights"
  | "nightCapPct"
  | "delta"
  | "maxDte"
  | "minPrice"
  | "minVolume"
  | "cheapFallback"
  | "minT"
  | "d2Entry"
  | "d2T"
  | "minD2"
  | "minRvol"
  | "firstEntryMin"
  | "skipEarnings"
  | "skipPremarket"
  | "lowFloorSymbols"
  | "lowFloorPrice"
  | "pyramid"
  | "pyramidSharePct"
  | "earlyEntry"
  | "stockStages"
  | "stageHalfS30"
  | "stageFullS30"
  | "lateHold"
  | "sizeSteps"
  | "breakEvenLock"
  | "lockArmPct"
  | "lowVolumeBelow"
  | "lowVolumeSizePct";

export type Rules = Pick<BotSettings, RuleKey>;

export const ruleKeys: readonly RuleKey[] = [
  "stopPct",
  "restStopPct",
  "checks",
  "sellOnWeakness",
  "weaknessT",
  "sellFailedBreak",
  "holdFromPct",
  "maxNights",
  "nightCapPct",
  "delta",
  "maxDte",
  "minPrice",
  "minVolume",
  "cheapFallback",
  "minT",
  "d2Entry",
  "d2T",
  "minD2",
  "minRvol",
  "firstEntryMin",
  "skipEarnings",
  "skipPremarket",
  "lowFloorSymbols",
  "lowFloorPrice",
  "pyramid",
  "pyramidSharePct",
  "earlyEntry",
  "stockStages",
  "stageHalfS30",
  "stageFullS30",
  "lateHold",
  "sizeSteps",
  "breakEvenLock",
  "lockArmPct",
  "lowVolumeBelow",
  "lowVolumeSizePct",
];

export interface BotVersion {
  id: string; // what entries are stamped with, e.g. "2.1.0"
  name: string;
  since: string; // the day it went live
  notes: string; // what changed from the version before
  rules: Rules;
}

// 1.0: the first bot, the rules as backtested on 2026-10-21 (docs/tasks/backend-indi-bot.md, "Rules").
const v1: Rules = {
  stopPct: 30,
  restStopPct: 0,
  checks: true,
  sellOnWeakness: false,
  weaknessT: 0.5,
  sellFailedBreak: false,
  holdFromPct: 100,
  maxNights: 2,
  nightCapPct: 0,
  delta: 0.15,
  maxDte: 7,
  minPrice: 0.2,
  minVolume: 200,
  cheapFallback: false,
  minT: 2,
  d2Entry: false,
  d2T: 1.2,
  minD2: 1.5,
  minRvol: 1.5,
  firstEntryMin: 10,
  skipEarnings: false,
  skipPremarket: false,
  lowFloorSymbols: [],
  lowFloorPrice: 0.1,
  pyramid: false,
  pyramidSharePct: 50,
  earlyEntry: false,
  stockStages: false,
  stageHalfS30: 0.5,
  stageFullS30: 1,
  lateHold: false,
  sizeSteps: [],
  breakEvenLock: false,
  lockArmPct: 50,
  lowVolumeBelow: 0,
  lowVolumeSizePct: 50,
};
// 2.0: the V2 champion (t 1.8, the overnight cap, the news filter).
const v2: Rules = {
  ...v1,
  minT: 1.8,
  nightCapPct: 10,
  skipEarnings: true,
  skipPremarket: true,
};
// 2.1: the owner's chosen failed-break sale on the entry day.
const v21: Rules = { ...v2, sellFailedBreak: true };
// 2.2: the t-stat exit (the 2026-10-24 champion): on the entry day, all out
// when the signal's own strength vs SPY × beta falls to t 0.5.
const v22: Rules = { ...v21, sellOnWeakness: true, weaknessT: 0.5 };
// 2.3: winners up +50% (not +100%) stay overnight (the user, 2026-10-24).
const v23: Rules = { ...v22, holdFromPct: 50 };
// 2.4: once the 10-minute check sold half, the rest's stop is -20% (not -30%)
// on the entry day (the user, 2026-10-24: be more careful with trades we
// already cut; the 2026-10-24 night champion, rest_stop2.py).
const v24: Rules = { ...v23, restStopPct: 20 };
// 2.5: the D2 bonus entry (the 2026-10-25 champion, the user's idea: holding
// up on the market's bad minutes earns an earlier entry), without the
// failed-break sale, which loses with it (d2_failed_break.py: fair list
// $669,231 / 14% with it vs $1,005,207 / 11% without).
const v25: Rules = { ...v24, sellFailedBreak: false, d2Entry: true };
// 2.6: the cheap fallback (the user, 2026-10-26, after the 2026-10-25 tests):
// when the 0.15-delta option costs under the minimum, the nearest strike toward
// the money at the minimum or more. Fair list $1,297,233 / 11% vs $1,108,678 /
// 11% for 2.5 at 1%; the Favorites' year $239,826 / 14% vs $192,534 / 12%.
const v26: Rules = { ...v25, cheapFallback: true };
// 2.7: the 2026-10-27 champion (research/indi-v2, best-algorithms.md; the
// user: "lets make this our champion"): 2.5 without the cheap fallback, IBIT
// bought down to $0.10 (its 0.15-delta option is often cheap and its trades
// are among the best), the pyramid (after a D2 bonus entry, half a size more
// in a fresh 0.15-delta option when the stock reaches the full signal that
// day while the first position is up), and early entry (the signal checked
// inside the minute on the latest trades, bought at the first check it holds).
// Real quotes, fair list, tune / check weeks (split.py): without early entry
// $257,982 / $368,105 vs 2.6's $229,933 / $272,798; early entry adds 8-13% on
// the 1-second data (sec_timing.py), checked every 5 seconds (every 10 keeps
// about half of it).
const v27: Rules = {
  ...v25,
  lowFloorSymbols: ["IBIT"],
  lowFloorPrice: 0.1,
  pyramid: true,
  pyramidSharePct: 50,
  earlyEntry: true,
};
// 2.8: the staged stock exit (the user, 2026-10-31: "add the Staged + stop -60%
// as our new version"; research/indi-v2 best-algorithms.md, after the backtest
// audit): the 10 / 20-minute checks are off; on the entry day half is sold once
// the stock is half its usual 30-minute move (S30) against the price at the
// signal, the rest at a full S30 against; the option stop is -60% (was -30%).
// Fixed backtest, 2%: fair list $4,161,285 / 25.5% vs 2.7's $3,202,862 / 26.6%
// (tune +18%, check +10%); the Favorites 12 months $269,142 vs $243,492, 36
// months $4,678,380 vs $4,490,376 (every year up); the check half lower on 3
// of the 5 lists, so it runs as the new version to be proven live. Also (the
// user, the same day: "do not sell if we bought after 15:00 and positive"): an
// entry at 15:00 or later is not sold on its entry day while above its cost,
// up to the 15:50 decision.
const v28: Rules = {
  ...v27,
  checks: false,
  stopPct: 60,
  stockStages: true,
  stageHalfS30: 0.5,
  stageFullS30: 1,
  lateHold: true,
};
// 2.8.1 (the owner, 2026-10-31: "3% until 300K -> 2.5 until 1M, 1.5 at 1M and 1
// at 4M ... commit it as the current 2.8.1"): 2.8 with the size stepping down as
// the account grows (the owner's base size, 3%, below $300K). 2.8 with every
// audit fix, marked at 15:50: fair list $5,020,559 / 39.0% vs flat 3%
// $7,162,638 / 43.3%; check half $1,167,393 / 24.9% vs $1,168,632 / 33.1%;
// the Favorites 12 months $297,769 vs $259,262.
const v281: Rules = {
  ...v28,
  sizeSteps: [
    { from: 300_000, pct: 2.5 },
    { from: 1_000_000, pct: 1.5 },
    { from: 4_000_000, pct: 1 },
  ],
};

// 2.9 (the owner, 2026-11-01: "add it now in all the places needed as 2.9, do
// not forget to use 2.8.1 (ladder)"): 2.8.1 + the break-even lock (research
// sim.py be_lock {arm 0.5, update}): on the entry day, once the option is +50%,
// the stock price where Black-Scholes at the option's implied volatility then
// values it at its cost is a stop on the stock, worked out again each minute it
// is still +50% (the tighter level kept). Fresh runs on the real fill price, 2%:
// fair list $3,455,683 / 32.2% vs 2.8's $3,138,672 / 34.4% (tune and check up);
// with the size steps $4,399,581 / 37.2% vs 2.8.1's $4,148,061 / 39.6%; the
// Favorites 12 / 6 / 24 / 36 months ahead with the drop 0.4-4 points less. The
// gain rests on about 10 changed trades (the strict check fails); the owner
// shipped it for the smaller drop and the higher win rate.
const v29: Rules = { ...v281, breakEvenLock: true, lockArmPct: 50 };
// 2.10 (the owner, 2026-11-01: "lets go with h20", after research/indi-v2
// trend_entry.py found the trades entered with volume >= 2x average about twice
// 2.9's trade on both halves and both lists): 2.9 with a signal whose volume
// since the open is under 2.0x its usual bought at half size (its pyramid add
// too). size_volume.py, real quotes, 2%: tune fair $358,139 / 19% and Favorites
// $414,405 / 13% vs 2.9's $376,230 / 29% and $555,017 / 18%; check $379,870 /
// 19% and $151,303 / 19% vs $478,021 / 25% and $143,834 / 25%; ahead of 2.9 cut
// to the same drop (0.6-0.75 of the size) on both halves and both lists.
const v210: Rules = { ...v29, lowVolumeBelow: 2, lowVolumeSizePct: 50 };

/** Every version, oldest first. */
export const botVersions: readonly BotVersion[] = [
  {
    id: "1.0.0",
    name: "Indi V1",
    since: "2026-10-21",
    notes:
      "The backtested rules: strength t 2 and volume 1.5×, delta 0.15, 1–7 days out, your stop and the overnight hold. No news filter, no overnight cap.",
    rules: v1,
  },
  {
    id: "2.0.0",
    name: "V2 champion",
    since: "2026-10-22",
    notes:
      "Strength t 1.8 (was 2), one contract holds at most 10% of the account overnight, and no entry on an earnings reaction day or with pre-market volume 4× normal.",
    rules: v2,
  },
  {
    id: "2.1.0",
    name: "V2 + failed-break sale",
    since: "2026-10-23",
    notes:
      "On the entry day, sell all when the stock reaches the next level ahead and falls back without breaking it.",
    rules: v21,
  },
  {
    id: "2.2.0",
    name: "V2.1 + t-stat exit",
    since: "2026-10-24",
    notes:
      "On the entry day, sell all when the signal's own strength vs SPY × beta (the t-stat that had to reach 1.8 to enter) falls to 0.5 or under.",
    rules: v22,
  },
  {
    id: "2.3.0",
    name: "V2.2, overnight from +50%",
    since: "2026-10-24",
    notes: "At 15:50, winners up 50% or more stay overnight (was 100%).",
    rules: v23,
  },
  {
    id: "2.4.0",
    name: "V2.3, the rest at −20% after the half",
    since: "2026-10-25",
    notes:
      "Once the 10-minute check sold half, the rest is sold at −20% (was −30%) with the stock against, on the entry day.",
    rules: v24,
  },
  {
    id: "2.5.0",
    name: "V2.4 + the D2 bonus entry",
    since: "2026-10-25",
    notes:
      "Also enters at strength t 1.2 when the stock held up on SPY's down minutes of the last 30 (D2 1.5 or more); no failed-break sale.",
    rules: v25,
  },
  {
    id: "2.6.0",
    name: "V2.5 + the cheap fallback",
    since: "2026-10-26",
    notes:
      "When the 0.15-delta option costs under the minimum, buys the nearest strike toward the money that costs the minimum or more, instead of skipping the signal.",
    rules: v26,
  },
  {
    id: "2.7.0",
    name: "Champion: IBIT $0.10, the pyramid, early entry",
    since: "2026-10-27",
    notes:
      "2.5 without the cheap fallback; IBIT is bought down to $0.10; after a D2 entry, half a size more when the stock reaches the full signal that day while the first position is up; and the signal is checked every few seconds inside the minute, buying at the first check it holds.",
    rules: v27,
  },
  {
    id: "2.8.0",
    name: "2.7 + the staged stock exit, stop −60%",
    since: "2026-10-31",
    notes:
      "No 10- and 20-minute checks. On the entry day, half is sold when the stock is half its usual 30-minute move against the price at the signal, the rest at a full move against; the option stop is −60% (was −30%). An entry at 15:00 or later is not sold before 15:50 while it is above its cost.",
    rules: v28,
  },
  {
    id: "2.8.1",
    name: "2.8 + the size steps down as the account grows",
    since: "2026-10-31",
    notes:
      "2.8's rules; each trade's size steps down as the account grows: your size (3%) below $300K, 2.5% from $300K, 1.5% from $1M, 1% from $4M, on the account as the day starts.",
    rules: v281,
  },
  {
    id: "2.9.0",
    name: "2.8.1 + the break-even lock",
    since: "2026-11-01",
    notes:
      "2.8.1's rules and size steps. On the entry day, once the option is up 50%, the bot works out the stock price where the option would be worth what was paid (Black-Scholes at its implied volatility now, again each minute it is still up 50%, the tighter level kept) and sells all if the stock gets back there.",
    rules: v29,
  },
  {
    id: "2.10.0",
    name: "2.9 + half size on weaker volume",
    since: "2026-11-01",
    notes:
      "2.9's rules. A signal whose volume since the open is under 2× its usual for that time buys half the size (its pyramid add too); at 2× or more, the full size.",
    rules: v210,
  },
];

/** The version a new bot runs. */
export const currentVersion = botVersions.at(-1)!.id;

// What the owner may call an own rule set: letters, digits, dots, dashes,
// plus, spaces and underscores; up to 24 characters.
export const versionLabelPattern = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,23}$/;

/**
 * A version id in the MAJOR.MINOR.PATCH form: ids from before the scheme gain
 * ".0" ("2.6" -> "2.6.0", "2.6*" -> "2.6.0*"); anything else stays as given.
 */
export function canonicalVersion(id: string): string {
  const m = /^(\d+\.\d+)(\*?)$/.exec(id);
  if (!m) return id;
  return `${m[1]}.0${m[2]}`;
}

export const versionById = (id: string): BotVersion | undefined => {
  const want = canonicalVersion(id);
  return botVersions.find((v) => v.id === want);
};

export type VersionBump = "minor" | "patch";

// The core settings and the rule switches: changing one is a MINOR change.
export const minorKeys: ReadonlySet<RuleKey> = new Set<RuleKey>([
  "minT",
  "minRvol",
  "delta",
  "stopPct",
  "holdFromPct",
  "maxNights",
  "checks",
  "d2Entry",
  "sellOnWeakness",
  "sellFailedBreak",
  "cheapFallback",
  "pyramid",
  "earlyEntry",
  "stockStages",
  "lateHold",
  "breakEvenLock",
  "skipEarnings",
  "skipPremarket",
]);
// Rules that are off at 0: switching one on or off is MINOR, a new value PATCH.
const offAtZero: ReadonlySet<RuleKey> = new Set<RuleKey>([
  "restStopPct",
  "nightCapPct",
  "lowVolumeBelow",
]);

/** How big a change of one rule from `from` to `to` is, or null when it is the same. */
export function ruleBump(
  key: RuleKey,
  from: unknown,
  to: unknown,
): VersionBump | null {
  if (sameValue(from, to)) return null;
  if (minorKeys.has(key)) return "minor";
  if (offAtZero.has(key) && (from === 0 || to === 0)) return "minor";
  return "patch";
}

/** The biggest change between two rule sets: "minor", "patch" or null (the same). */
export function versionBump(from: Rules, to: Rules): VersionBump | null {
  let out: VersionBump | null = null;
  for (const key of ruleKeys) {
    const b = ruleBump(key, from[key], to[key]);
    if (b === "minor") return "minor";
    if (b) out = b;
  }
  return out;
}

/** The id a change of that size makes from a version: 2.7.0 -> 2.8.0 / 2.7.1. */
export function nextVersionId(id: string, bump: VersionBump): string {
  const [major = 0, minor = 0, patch = 0] = canonicalVersion(id)
    .split(".")
    .map(Number);
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Just the rules of a settings object. */
export function rulesOf(s: Rules): Rules {
  const out: Partial<Rules> = {};
  for (const key of ruleKeys) (out as Record<string, unknown>)[key] = s[key];
  return out as Rules;
}

// A rule is a number, a boolean or a list of tickers (compared in order).
// Lists by their contents (JSON: a list of size steps is a list of objects).
const sameValue = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b)
    ? JSON.stringify(a) === JSON.stringify(b)
    : a === b;

export const sameRules = (a: Rules, b: Rules): boolean =>
  ruleKeys.every((key) => sameValue(a[key], b[key]));

/** The newest version whose rules are exactly these, if any. */
export function matchingVersion(s: Rules): BotVersion | undefined {
  return [...botVersions].reverse().find((v) => sameRules(v.rules, s));
}

const itemText = (x: unknown): string => {
  if (typeof x !== "object" || x === null) return String(x);
  const { from, pct } = x as { from?: number; pct?: number };
  return `${pct}% from $${(from ?? 0).toLocaleString("en-US")}`;
};
const ruleText = (v: unknown): string =>
  Array.isArray(v) ? v.map(itemText).join(", ") || "none" : String(v);

/** Where the rules differ from a version's, in words ("stopPct 30 → 40"). */
export function ruleChanges(s: Rules, v: BotVersion): string[] {
  const out: string[] = [];
  for (const key of ruleKeys)
    if (!sameValue(s[key], v.rules[key]))
      out.push(`${key} ${ruleText(v.rules[key])} → ${ruleText(s[key])}`);
  return out;
}

/**
 * What an entry is stamped with: the chosen version, with a star when the
 * rules were changed from it ("2.1*"); an own label stays as typed.
 */
export function versionLabel(s: BotSettings): string {
  const known = versionById(s.version);
  if (!known) return s.version;
  if (sameRules(s, known.rules)) return known.id;
  return `${known.id}*`;
}

/** The settings with a version's rules, and that version chosen. */
export function applyVersion(s: BotSettings, id: string): BotSettings {
  const v = versionById(id);
  if (!v) return { ...s, version: id };
  return { ...s, ...v.rules, version: v.id };
}
