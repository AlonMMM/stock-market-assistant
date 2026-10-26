import type { BotSettings } from "./settings.js";

// The bot's versions (docs/tasks/backend-bot-settings.md, "Versions"): each
// is a named set of the trading rules, the settings that decide when the bot
// enters, what it buys and how it exits. The owner picks the version the bot
// runs on the settings page; every signal and position is stamped with the
// version in force when it was entered, so results can be read per version.
// The owner's own limits (size, buys a day, open positions, the daily loss,
// the drawdown pause, the broker safety stop) and the stock lists are not part
// of a version.

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
  | "skipPremarket";

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
];

export interface BotVersion {
  id: string; // what entries are stamped with, e.g. "2.1"
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

/** Every version, oldest first. */
export const botVersions: readonly BotVersion[] = [
  {
    id: "1.0",
    name: "Indi V1",
    since: "2026-10-21",
    notes:
      "The backtested rules: strength t 2 and volume 1.5×, delta 0.15, 1–7 days out, your stop and the overnight hold. No news filter, no overnight cap.",
    rules: v1,
  },
  {
    id: "2.0",
    name: "V2 champion",
    since: "2026-10-22",
    notes:
      "Strength t 1.8 (was 2), one contract holds at most 10% of the account overnight, and no entry on an earnings reaction day or with pre-market volume 4× normal.",
    rules: v2,
  },
  {
    id: "2.1",
    name: "V2 + failed-break sale",
    since: "2026-10-23",
    notes:
      "On the entry day, sell all when the stock reaches the next level ahead and falls back without breaking it.",
    rules: v21,
  },
  {
    id: "2.2",
    name: "V2.1 + t-stat exit",
    since: "2026-10-24",
    notes:
      "On the entry day, sell all when the signal's own strength vs SPY × beta (the t-stat that had to reach 1.8 to enter) falls to 0.5 or under.",
    rules: v22,
  },
  {
    id: "2.3",
    name: "V2.2, overnight from +50%",
    since: "2026-10-24",
    notes: "At 15:50, winners up 50% or more stay overnight (was 100%).",
    rules: v23,
  },
  {
    id: "2.4",
    name: "V2.3, the rest at −20% after the half",
    since: "2026-10-25",
    notes:
      "Once the 10-minute check sold half, the rest is sold at −20% (was −30%) with the stock against, on the entry day.",
    rules: v24,
  },
  {
    id: "2.5",
    name: "V2.4 + the D2 bonus entry",
    since: "2026-10-25",
    notes:
      "Also enters at strength t 1.2 when the stock held up on SPY's down minutes of the last 30 (D2 1.5 or more); no failed-break sale.",
    rules: v25,
  },
  {
    id: "2.6",
    name: "V2.5 + the cheap fallback",
    since: "2026-10-26",
    notes:
      "When the 0.15-delta option costs under the minimum, buys the nearest strike toward the money that costs the minimum or more, instead of skipping the signal.",
    rules: v26,
  },
];

/** The version a new bot runs. */
export const currentVersion = botVersions.at(-1)!.id;

// What the owner may call an own rule set: letters, digits, dots, dashes,
// plus, spaces and underscores; up to 24 characters.
export const versionLabelPattern = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,23}$/;

export const versionById = (id: string): BotVersion | undefined =>
  botVersions.find((v) => v.id === id);

/** Just the rules of a settings object. */
export function rulesOf(s: Rules): Rules {
  const out: Partial<Rules> = {};
  for (const key of ruleKeys) (out as Record<string, unknown>)[key] = s[key];
  return out as Rules;
}

export const sameRules = (a: Rules, b: Rules): boolean =>
  ruleKeys.every((key) => a[key] === b[key]);

/** The newest version whose rules are exactly these, if any. */
export function matchingVersion(s: Rules): BotVersion | undefined {
  return [...botVersions].reverse().find((v) => sameRules(v.rules, s));
}

/** Where the rules differ from a version's, in words ("stopPct 30 → 40"). */
export function ruleChanges(s: Rules, v: BotVersion): string[] {
  const out: string[] = [];
  for (const key of ruleKeys)
    if (s[key] !== v.rules[key])
      out.push(`${key} ${String(v.rules[key])} → ${String(s[key])}`);
  return out;
}

/**
 * What an entry is stamped with: the chosen version, with a star when the
 * rules were changed from it ("2.1*"); an own label stays as typed.
 */
export function versionLabel(s: BotSettings): string {
  const known = versionById(s.version);
  if (!known) return s.version;
  if (sameRules(s, known.rules)) return s.version;
  return `${s.version}*`;
}

/** The settings with a version's rules, and that version chosen. */
export function applyVersion(s: BotSettings, id: string): BotSettings {
  const v = versionById(id);
  if (!v) return { ...s, version: id };
  return { ...s, ...v.rules, version: id };
}
