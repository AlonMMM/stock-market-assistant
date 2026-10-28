import type { BotView } from "../../../packages/trading/src/bot-api.js";
import {
  defaultSettings,
  neverWatched,
  type BotSettings,
} from "../../../packages/trading/src/bot/settings.js";

// The bot's settings page (docs/tasks/frontend-bot-settings.md): the stocks
// the bot would watch and the page's checks. The settings themselves, their
// defaults and limits are shared with the bot (packages/trading/src/bot/settings.ts).
// A trading service without `/api/bot/settings` gets the page's fallback: what
// `GET /api/bot` reports.

import {
  botVersions,
  nextVersionId,
  ruleChanges,
  versionBump,
  versionById,
  versionLabel,
  type BotVersion,
  type VersionBump,
} from "../../../packages/trading/src/bot/versions.js";

export {
  defaultSettings,
  neverWatched,
  untested,
  type BotSettings,
  type NumberKey,
} from "../../../packages/trading/src/bot/settings.js";
export {
  applyVersion,
  botVersions,
  canonicalVersion,
  versionLabel,
  versionLabelPattern,
  type BotVersion,
  type Rules,
} from "../../../packages/trading/src/bot/versions.js";
export {
  algorithmSteps,
  type AlgorithmStep,
} from "../../../packages/trading/src/bot/algorithm.js";
export type SwitchKey =
  | "checks"
  | "sellOnWeakness"
  | "sellFailedBreak"
  | "cheapFallback"
  | "d2Entry"
  | "skipEarnings"
  | "skipPremarket";

/**
 * The version card's state: the known version chosen (none for an own label),
 * where the rules below differ from it, what entries are stamped with, and,
 * when the rules differ, how big the change is and the number it would make
 * (MAJOR.MINOR.PATCH, packages/trading/src/bot/versions.ts).
 */
export function versionState(s: BotSettings): {
  known: BotVersion | undefined;
  changes: string[];
  label: string;
  latest: boolean;
  bump: VersionBump | null;
  next: string | null;
} {
  const known = versionById(s.version);
  const bump = known ? versionBump(known.rules, s) : null;
  return {
    known,
    changes: known ? ruleChanges(s, known) : [],
    label: versionLabel(s),
    latest: known?.id === botVersions.at(-1)!.id,
    bump,
    next: known && bump ? nextVersionId(known.id, bump) : null,
  };
}

/**
 * The settings as far as the bot reports them, the defaults for the rest.
 * Stocks the bot reports but does not watch today start off.
 */
export function fromBotView(v: BotView): BotSettings {
  if (v.settings) return v.settings;
  const listed = candidates(v.universe, v.favorites?.tickers ?? [], []);
  const watching = new Set(v.watching);
  let off = defaultSettings.off.slice();
  if (watching.size > 0) off = listed.filter((t) => !watching.has(t));
  return {
    ...defaultSettings,
    enabled: v.enabled,
    mode: v.mode,
    sizePct: v.sizePct,
    delta: v.delta,
    off,
  };
}

/** Every stock on the page, in order: core, then the owner's, then favorites. */
function candidates(
  core: readonly string[],
  favorites: readonly string[],
  added: readonly string[],
): string[] {
  const all: string[] = [];
  for (const t of [...core, ...added, ...favorites])
    if (!all.includes(t) && !neverWatched.includes(t)) all.push(t);
  return all;
}

export interface TickerItem {
  t: string;
  on: boolean;
  core: boolean;
  favorite: boolean;
  added: boolean;
}

/** The stocks shown, each with where it comes from and whether it is on. */
export function tickerItems(
  s: BotSettings,
  core: readonly string[],
  favorites: readonly string[],
): TickerItem[] {
  const favs = s.followFavorites ? favorites : [];
  return candidates(core, favs, s.added).map((t) => ({
    t,
    on: !s.off.includes(t),
    core: core.includes(t),
    favorite: favs.includes(t),
    added: s.added.includes(t) && !core.includes(t),
  }));
}

/** Turns one stock on or off. */
export function toggleTicker(s: BotSettings, t: string): BotSettings {
  if (s.off.includes(t)) return { ...s, off: s.off.filter((x) => x !== t) };
  return { ...s, off: [...s.off, t] };
}

/** Adds a ticker, or turns a listed one back on; an error in words otherwise. */
export function addTicker(
  s: BotSettings,
  text: string,
  listed: readonly string[],
): BotSettings | string {
  const t = text.trim().toUpperCase();
  if (!/^[A-Z][A-Z.]{0,5}$/.test(t)) return "Type a ticker: 1–6 letters.";
  if (t === "SPY") return "SPY is the benchmark the bot measures against.";
  if (neverWatched.includes(t)) return `${t} is a future; the bot skips it.`;
  const off = s.off.filter((x) => x !== t);
  if (listed.includes(t) || s.added.includes(t)) return { ...s, off };
  return { ...s, off, added: [...s.added, t] };
}

/** The settings changed against the defaults (the current version), keeping on/off, the mode and the broker. */
export function resetToDefaults(s: BotSettings): BotSettings {
  return {
    ...defaultSettings,
    enabled: s.enabled,
    mode: s.mode,
    broker: s.broker,
  };
}

export const sameSettings = (a: BotSettings, b: BotSettings) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Values that work against each other, in words. */
export function settingsWarnings(s: BotSettings): string[] {
  const out: string[] = [];
  if (s.safetyStopPct <= s.stopPct)
    out.push(
      `The broker safety stop (−${s.safetyStopPct}%) is at or above the stop (−${s.stopPct}%), so it fires first.`,
    );
  if (s.sizePct > 3)
    out.push(
      `${s.sizePct}% a trade is above the backtested 2%; one position is capped at 5% by your risk rules.`,
    );
  return out;
}

/** Whether a value sits outside what the backtest ran. */
export function leftBacktest(s: BotSettings): boolean {
  return (
    s.minT !== defaultSettings.minT ||
    s.minRvol !== defaultSettings.minRvol ||
    s.firstEntryMin !== defaultSettings.firstEntryMin ||
    s.skipEarnings !== defaultSettings.skipEarnings ||
    s.skipPremarket !== defaultSettings.skipPremarket
  );
}
