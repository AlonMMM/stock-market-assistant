import type { BotView } from "../../../packages/trading/src/bot-api.js";

// The bot's settings page (docs/tasks/frontend-bot-settings.md): the values the
// owner can change, their defaults, and the stocks the bot would watch. The
// shape is the proposed `GET/PUT /api/bot/settings` contract; until the
// trading service serves it, the page starts from what `GET /api/bot` reports.

export interface BotSettings {
  enabled: boolean;
  mode: "live" | "dry";
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
  // Profits and holding
  holdFromPct: number;
  maxNights: number;
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
export type SwitchKey = "checks" | "skipEarnings" | "skipPremarket";

// What the bot runs today (docs/tasks/backend-indi-bot.md). The index ETFs
// start off: the backtest left them out.
export const defaultSettings: BotSettings = {
  enabled: true,
  mode: "live",
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
  holdFromPct: 100,
  maxNights: 2,
  delta: 0.15,
  maxDte: 7,
  minPrice: 0.2,
  minVolume: 200,
  minT: 2,
  minRvol: 1.5,
  firstEntryMin: 10,
  skipEarnings: true,
  skipPremarket: true,
};

// Values the backtest never ran; their hint says "Default", not "Backtest".
export const untested: ReadonlySet<keyof BotSettings> = new Set([
  "maxBuysPerDay",
  "maxOpen",
  "safetyStopPct",
  "dayLossPct",
  "drawdownPausePct",
]);

// SPY is the benchmark; the futures have no options the bot buys.
export const neverWatched = ["SPY", "CL", "GC", "SI"];

/**
 * The settings as far as the bot reports them, the defaults for the rest.
 * Stocks the bot reports but does not watch today start off.
 */
export function fromBotView(v: BotView): BotSettings {
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

/** The settings changed against the defaults, keeping on/off and the mode. */
export function resetToDefaults(s: BotSettings): BotSettings {
  return { ...defaultSettings, enabled: s.enabled, mode: s.mode };
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
