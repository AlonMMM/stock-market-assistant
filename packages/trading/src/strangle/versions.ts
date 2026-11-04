import type { StrangleSettings } from "./settings.js";

// The Volume bot's versions (the user, 2026-11-02: "use our version system to
// start this version. be careful not to mix with the main bot"). The same
// scheme as the Main bot's (bot/versions.ts) but its own list, ids and keys:
// each version is a named set of the Volume bot's trading rules; every trade is
// stamped with the version in force when it was entered. The owner's limits
// (size, trades a day, open trades, the day loss, the broker safety stop) and
// the stock list are not part of a version.
//
// Numbering, MAJOR.MINOR.PATCH, shown as "Volume 1.1.0":
//   MAJOR  the strategy redefined and re-backtested from scratch
//   MINOR  a rule added, removed or switched on / off
//   PATCH  a rule's own numbers change
// A version run with changed rules is stamped with a star ("1.1.0*").

export type VolumeRuleKey =
  | "maxPerStock"
  | "firstMinute"
  | "nextDay"
  | "lastMinute"
  | "delta"
  | "minPrice"
  | "minVolume"
  | "liquidFallback"
  | "cheapRescue"
  | "confirmUnits"
  | "waitMinutes"
  | "giveBackUnits"
  | "endMinute"
  | "strengthFilter"
  | "crossFilter"
  | "crossMaxSeconds"
  | "burstFilter"
  | "burstMin"
  | "weekExpiry"
  | "burstMinWeek"
  | "noStopMinutes"
  | "exitOnMinuteClose"
  | "fastAlert"
  | "shockAlert"
  | "shockTouchSeconds"
  | "shockAgainstUnits"
  | "shockPaceMin"
  | "skipEarnings"
  | "skipPremarket";

export type VolumeRules = Pick<StrangleSettings, VolumeRuleKey>;

export const volumeRuleKeys: readonly VolumeRuleKey[] = [
  "maxPerStock",
  "firstMinute",
  "nextDay",
  "lastMinute",
  "delta",
  "minPrice",
  "minVolume",
  "liquidFallback",
  "cheapRescue",
  "confirmUnits",
  "waitMinutes",
  "giveBackUnits",
  "endMinute",
  "strengthFilter",
  "crossFilter",
  "crossMaxSeconds",
  "burstFilter",
  "burstMin",
  "weekExpiry",
  "burstMinWeek",
  "noStopMinutes",
  "exitOnMinuteClose",
  "fastAlert",
  "shockAlert",
  "shockTouchSeconds",
  "shockAgainstUnits",
  "shockPaceMin",
  "skipEarnings",
  "skipPremarket",
];

export interface VolumeVersion {
  id: string; // what trades are stamped with, e.g. "1.1.0"
  name: string;
  since: string; // the day it went live
  notes: string; // what changed from the version before
  rules: VolumeRules;
}

// 1.0.0: the rules live 2026-10-30 .. 2026-11-01 (the plan alert with the
// 15-s cross and the burst, the shock alert, the 30-minute grace), as saved.
const v1: VolumeRules = {
  maxPerStock: 2,
  firstMinute: 10,
  nextDay: true,
  lastMinute: 209,
  delta: 0.2,
  minPrice: 0.2,
  minVolume: 200,
  liquidFallback: true,
  cheapRescue: false,
  confirmUnits: 0.25,
  waitMinutes: 10,
  giveBackUnits: 0.75,
  endMinute: 360,
  strengthFilter: false,
  crossFilter: true,
  crossMaxSeconds: 15,
  burstFilter: true,
  burstMin: 1.1,
  weekExpiry: true,
  burstMinWeek: 2.5,
  noStopMinutes: 30,
  exitOnMinuteClose: true,
  fastAlert: false,
  shockAlert: true,
  shockTouchSeconds: 300,
  shockAgainstUnits: 0,
  shockPaceMin: 0,
  skipEarnings: true,
  skipPremarket: true,
};

export const volumeVersions: readonly VolumeVersion[] = [
  {
    id: "1.0.0",
    name: "Volume 1.0.0",
    since: "2026-10-30",
    notes:
      "The plan alert (15-s cross, burst 1.1, same-week 2.5) and the shock alert (5 checks in a row within 300 s), the 0.20 leg with the liquid fallback, the give-back on minute closes after a 30-minute grace.",
    rules: v1,
  },
  {
    id: "1.1.0",
    name: "Volume 1.1.0",
    since: "2026-11-02",
    notes:
      "The research's rules (PR #236): a shock trades only when the stock touches a side line within 20 s of the alert; a leg under the minimum price that is also thin takes a liquid strike. Year 2025-11 .. 2026-10, 51 stocks, 2%, no stop: $100K -> $142.1K, worst drop 13%.",
    rules: { ...v1, shockTouchSeconds: 20, cheapRescue: true },
  },
  {
    id: "1.2.0",
    name: "Volume 1.2.0",
    since: "2026-11-03",
    notes:
      "1.1.0 + no shock against the day's move: a shock alert against the stock's move since the open, once that move is 2 typical 30-minute moves or more, is skipped (the user, ORCL 2026-10-28). Year 2025-11 .. 2026-10, 51 stocks, 2%: $142.1K -> $149.4K, drop 13% -> 12%; 3-year twin $773K -> $867K, drop 21.1% -> 18.5%, better on tune and check.",
    rules: {
      ...v1,
      shockTouchSeconds: 20,
      cheapRescue: true,
      shockAgainstUnits: 2,
    },
  },
  {
    id: "1.3.0",
    name: "Volume 1.3.0",
    since: "2026-11-04",
    notes:
      "1.2.0 + the shock against today's own volume: the 60-second window also at least 3x today's pace, so a shock is a sudden jump on the day, not only against other days (the user, 2026-11-03). Year 2025-11 .. 2026-10, 50 stocks, 2%: $153.1K -> $154.4K (a tie), drop 12% -> 13%; 3-year twin $896K -> $937K, drop 18.7% -> 18.0%, better on tune and check.",
    rules: {
      ...v1,
      shockTouchSeconds: 20,
      cheapRescue: true,
      shockAgainstUnits: 2,
      shockPaceMin: 3,
    },
  },
];

export const currentVolumeVersion = volumeVersions.at(-1)!.id;

export const volumeVersionById = (id: string): VolumeVersion | undefined =>
  volumeVersions.find((v) => v.id === id);

export function volumeRulesOf(s: VolumeRules): VolumeRules {
  const out = {} as Record<VolumeRuleKey, unknown>;
  for (const k of volumeRuleKeys) out[k] = s[k];
  return out as VolumeRules;
}

export const sameVolumeRules = (a: VolumeRules, b: VolumeRules): boolean =>
  volumeRuleKeys.every((k) => a[k] === b[k]);

/** The rules that differ from the version's, as "key: version -> now". */
export function volumeRuleChanges(s: VolumeRules, v: VolumeVersion): string[] {
  return volumeRuleKeys
    .filter((k) => s[k] !== v.rules[k])
    .map((k) => `${k}: ${String(v.rules[k])} -> ${String(s[k])}`);
}

/** The version in force: its id, with a star when the saved rules differ from it. */
export function volumeVersionLabel(s: StrangleSettings): string {
  const known = volumeVersionById(s.version);
  if (!known) return s.version;
  if (sameVolumeRules(s, known.rules)) return known.id;
  return `${known.id}*`;
}

/** The settings with a version's rules; the owner's limits and stocks stay. */
export function applyVolumeVersion(
  s: StrangleSettings,
  id: string,
): StrangleSettings {
  const v = volumeVersionById(id);
  if (!v) return s;
  return { ...s, ...v.rules, version: v.id };
}
