// The alert leg's settings (docs/tasks/backend-strangle-bot.md): a second
// bot, separate from the Indi bot, on its own Alpaca paper account (user
// 2026-10-25: "create another test with this strategy and test it - not mix
// them ... edit the settings and see the trades in our app"; then "the one
// leg looks much better than the strangle - go with it"). The defaults are the
// rule backtested in `strangle_more.py` (research/indi-v2,
// docs/research/best-algorithms.md): on the first volume alert, wait for the
// side, buy only that leg, sell on the stock's give-back. The code keeps the
// name "strangle" for the module, its routes and its tables.

export interface StrangleSettings {
  enabled: boolean;
  mode: "live" | "dry";
  // Stocks: the favorites list (sent by the site before each session) and
  // the owner's own, less those turned off.
  followFavorites: boolean;
  added: string[];
  off: string[];
  // Size: the leg costs this share of the account.
  sizePct: number;
  maxTradesPerDay: number;
  // Trades a stock may take in a day: a later alert burst on it starts a new
  // watch once it has nothing open and fewer trades than this (user
  // 2026-10-26, "go with your recommendation"; leg_twice.py: 2 is best with
  // the day's caps). 1 = one trade a stock a day.
  maxPerStock: number;
  maxOpen: number;
  dayLossPct: number;
  // The broker's stop on every leg, % under its cost, in case the service is
  // down. The owner's risk rules refuse a buy while a contract has no stop;
  // the trail and the wrong-leg sale act long before it.
  safetyStopPct: number;
  // Entry: the first volume alert of the day, from firstMinute to lastMinute
  // (session minutes, 09:30 New York = 0), on days with a same-day expiry.
  firstMinute: number;
  // Also days whose nearest expiry is the next session (1DTE, mostly
  // Thursdays): the same rule on that expiry's leg, still sold the same day
  // (user 2026-10-25, "implement it"; leg_1dte.py: better on both lists).
  nextDay: boolean;
  lastMinute: number;
  delta: number;
  minPrice: number; // each leg's mid
  minVolume: number; // each leg's contracts in the last 30 minutes
  // The leg too thin: the nearest strike that is not, further out (to delta
  // 0.25) then toward the money (to 0.50), at the same minimums (user
  // 2026-10-26, "implement the liquid fallback"; picker.ts liquidOrder).
  liquidFallback: boolean;
  // The side: the stock moves this many typical 30-minute moves from where it
  // was at the alert; only then is the leg of that side bought.
  confirmUnits: number;
  waitMinutes: number; // no side by then: no trade
  // The exit: the leg is sold when the stock gives back this many typical
  // 30-minute moves from its best since the buy.
  giveBackUnits: number;
  endMinute: number; // everything out by then (15:30 = 360)
  // Optional: buy only when the stock's strength vs SPY x beta since the open
  // points the way of the side (else no trade).
  strengthFilter: boolean;
  // The winner of 2026-10-27 (docs/research/volume-bot.md, research/indi-v2;
  // the user 2026-10-28, "the last version of this bot in production today"):
  // buy only when the stock crosses the side line within crossMaxSeconds of
  // the alert, and its burst (the alert minute's close against the close 3
  // minutes before, in typical 30-minute moves) points the side's way by at
  // least burstMin; no give-back sale for noStopMinutes after the buy; the
  // give-back read on minute closes, as the backtest does, not on every tick.
  crossFilter: boolean;
  crossMaxSeconds: number;
  burstFilter: boolean;
  burstMin: number;
  // Days with no expiry today or the next session: the nearest expiry later
  // that week (2-4 DTE), only when the burst is at least burstMinWeek the
  // side's way (user 2026-10-29, "implement and deploy"; volume-bot.md "2-4
  // DTE with a stronger burst": 0/1 DTE + 2-4 DTE at 2.5, no limits, 2 a
  // stock: 258 trades, $100K -> $513K at 2% in 3 years). Still sold the same day.
  weekExpiry: boolean;
  burstMinWeek: number;
  noStopMinutes: number;
  exitOnMinuteClose: boolean;
  // The news filter, as the Indi bot's.
  skipEarnings: boolean;
  skipPremarket: boolean;
}

export type StrangleNumberKey = {
  [K in keyof StrangleSettings]: StrangleSettings[K] extends number ? K : never;
}[keyof StrangleSettings];
type BooleanKey = {
  [K in keyof StrangleSettings]: StrangleSettings[K] extends boolean
    ? K
    : never;
}[keyof StrangleSettings];

// Dry run and off until the owner switches it on: a new account, a new rule.
export const defaultStrangleSettings: StrangleSettings = {
  enabled: false,
  mode: "dry",
  followFavorites: true,
  added: [],
  off: [],
  sizePct: 1,
  // 15 (user 2026-10-26, "go with 15 trades for day limit"): at 5 the cap refused about
  // 480 trades a year on the watchlists, most of them winners (bench, leg_twice.py).
  maxTradesPerDay: 15,
  maxPerStock: 2,
  maxOpen: 3,
  // 7.5 (user 2026-10-26); at 1% a trade the backtest never reached 5.
  dayLossPct: 7.5,
  safetyStopPct: 70,
  firstMinute: 10,
  nextDay: true,
  lastMinute: 209,
  delta: 0.35,
  minPrice: 0.2,
  minVolume: 200,
  liquidFallback: true,
  confirmUnits: 0.25,
  // 10, not the backtest's first 60 (user 2026-10-26, "implement the 10 minutes give up";
  // leg_entry.py: a side after 10 minutes loses on both lists).
  waitMinutes: 10,
  giveBackUnits: 0.75,
  endMinute: 360,
  strengthFilter: false,
  // The winner: 194 trades in 3 years on the top 50, +25% a trade after costs
  // at 2% (today's rules on every alert: -9% a trade).
  crossFilter: true,
  crossMaxSeconds: 15,
  burstFilter: true,
  burstMin: 1.1,
  weekExpiry: true,
  burstMinWeek: 2.5,
  noStopMinutes: 30,
  exitOnMinuteClose: true,
  skipEarnings: true,
  skipPremarket: true,
};

// What each number may be, with its step (the page's sliders). Size up to 6%
// (user 2026-10-25, the sizing slider); delta in the backtested band.
export const strangleLimits: Record<
  StrangleNumberKey,
  [min: number, max: number, step: number]
> = {
  sizePct: [0.5, 6, 0.5],
  // One buy a trade; the account's buys-per-day rule must allow as many.
  // Up to 100 a day, 50 open and a 100% day loss: "no limits" (user 2026-10-29).
  maxTradesPerDay: [1, 100, 1],
  maxPerStock: [1, 5, 1],
  maxOpen: [1, 50, 1],
  dayLossPct: [1, 100, 0.5],
  safetyStopPct: [30, 70, 5],
  firstMinute: [5, 120, 5],
  lastMinute: [30, 300, 1],
  delta: [0.2, 0.5, 0.05],
  minPrice: [0.05, 1, 0.05],
  minVolume: [0, 1000, 10],
  confirmUnits: [0.1, 1, 0.05],
  waitMinutes: [10, 120, 5],
  giveBackUnits: [0.25, 1.5, 0.05],
  endMinute: [300, 375, 5],
  crossMaxSeconds: [5, 120, 1],
  burstMin: [0, 3, 0.1],
  burstMinWeek: [0, 4, 0.1],
  noStopMinutes: [0, 60, 5],
};

// Values the backtest never ran.
export const strangleUntested: ReadonlySet<keyof StrangleSettings> = new Set([
  "safetyStopPct",
  "maxTradesPerDay",
  "maxOpen",
  "dayLossPct",
]);

const booleans: BooleanKey[] = [
  "enabled",
  "followFavorites",
  "nextDay",
  "liquidFallback",
  "strengthFilter",
  "crossFilter",
  "burstFilter",
  "weekExpiry",
  "exitOnMinuteClose",
  "skipEarnings",
  "skipPremarket",
];
const ticker = /^[A-Z][A-Z.]{0,5}$/;
const maxTickers = 200;
export const strangleNeverWatched = ["SPY"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A whole settings object from a request, or what is wrong with it. */
export function parseStrangleSettings(
  body: unknown,
): { ok: true; value: StrangleSettings } | { ok: false; error: string } {
  if (!isObject(body)) return { ok: false, error: "Expected a JSON object" };
  const out = { ...defaultStrangleSettings };
  for (const key of booleans) {
    const v = body[key];
    if (typeof v !== "boolean")
      return { ok: false, error: `${key} must be true or false` };
    out[key] = v;
  }
  if (body.mode !== "live" && body.mode !== "dry")
    return { ok: false, error: "mode must be live or dry" };
  out.mode = body.mode;
  for (const [key, [min, max, step]] of Object.entries(strangleLimits) as [
    StrangleNumberKey,
    [number, number, number],
  ][]) {
    const v = body[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
      return {
        ok: false,
        error: `${key} must be a number from ${min} to ${max}`,
      };
    out[key] = Number((Math.round(v / step) * step).toFixed(4));
  }
  if (out.lastMinute <= out.firstMinute)
    return { ok: false, error: "lastMinute must be after firstMinute" };
  if (out.endMinute <= out.lastMinute)
    return { ok: false, error: "endMinute must be after lastMinute" };
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
  out.added = out.added.filter((t) => !strangleNeverWatched.includes(t));
  return { ok: true, value: out };
}

/** Saved values over the defaults; anything not valid falls back to them. */
/**
 * A change of some settings (the connector's volume_bot_update_settings, user
 * 2026-10-28: "an admin endpoint ... so you can edit the settings as we
 * need"): only known keys, merged over the current settings, then checked as a
 * whole. -> the new settings and the keys whose value changed, or the error.
 */
export function mergeStrangleSettings(
  current: StrangleSettings,
  patch: unknown,
):
  | { ok: true; value: StrangleSettings; changed: (keyof StrangleSettings)[] }
  | { ok: false; error: string } {
  if (!isObject(patch) || !Object.keys(patch).length)
    return {
      ok: false,
      error: "Expected an object with the settings to change",
    };
  const unknown = Object.keys(patch).filter((k) => !(k in current));
  if (unknown.length)
    return { ok: false, error: `Unknown settings: ${unknown.join(", ")}` };
  const checked = parseStrangleSettings({ ...current, ...patch });
  if (!checked.ok) return checked;
  const changed = (Object.keys(current) as (keyof StrangleSettings)[]).filter(
    (k) => JSON.stringify(current[k]) !== JSON.stringify(checked.value[k]),
  );
  return { ok: true, value: checked.value, changed };
}

export function strangleWithDefaults(
  saved: unknown,
  base: StrangleSettings = defaultStrangleSettings,
): StrangleSettings {
  const merged = { ...base, ...(isObject(saved) ? saved : {}) };
  const checked = parseStrangleSettings(merged);
  return checked.ok ? checked.value : base;
}

/** The stocks to watch: the owner's, the favorites if followed, less those off. */
export function strangleStocks(
  s: StrangleSettings,
  favorites: readonly string[],
): string[] {
  const all = [...s.added, ...(s.followFavorites ? favorites : [])];
  return [...new Set(all)].filter(
    (t) => !s.off.includes(t) && !strangleNeverWatched.includes(t),
  );
}

export const clockOf = (minute: number): string => {
  const m = 570 + minute;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};

/** The rule in words, one step per decision, for the settings page and the tab. */
export function strangleSteps(
  s: StrangleSettings,
): { name: string; text: string }[] {
  const nextDayWords = s.nextDay
    ? " (or, when there is none, one the next session: 1DTE)"
    : "";
  // One trade a stock a day, or a later burst once it has nothing open.
  let perStockWords = ". One trade per stock a day";
  if (s.maxPerStock > 1)
    perStockWords = `; a later burst on the same stock counts once it has nothing open, up to ${s.maxPerStock} trades a stock a day`;
  // Too thin: no trade, or the nearest strike that trades enough.
  let thinWords = "";
  if (s.minVolume > 0 && s.liquidFallback)
    thinWords =
      " Too thin: the nearest strike that is not, further out to delta 0.25, then toward the money to 0.50.";
  const news = [
    s.skipEarnings && "the stock's earnings reaction day",
    s.skipPremarket && "a pre-market volume of 4× normal or more",
  ].filter(Boolean);
  return [
    {
      name: "The alert",
      text: `On a day with a same-day expiry${nextDayWords}${s.weekExpiry ? `, or else the nearest expiry later that week when the burst is at least ${s.burstMinWeek}` : ""}, from ${clockOf(s.firstMinute)} to ${clockOf(s.lastMinute)} New York, when a volume alert fires on a stock, in either direction${perStockWords}.`,
    },
    {
      name: "News filter",
      text: news.length ? `No trade on ${news.join(" or ")}.` : "Off.",
    },
    {
      name: "The side",
      text: `Wait until the stock has moved ${s.confirmUnits} of its typical 30-minute move from where it was at the alert, up or down${s.strengthFilter ? ", with the stock's strength vs SPY × β since the open pointing the same way" : ""}. No side within ${s.crossFilter ? `${s.crossMaxSeconds} seconds` : `${s.waitMinutes} minutes`}: no trade.${s.burstFilter ? ` Only when the 3 minutes up to the alert already moved at least ${s.burstMin} of the typical 30-minute move the side's way.` : ""}`,
    },
    {
      name: "Buy",
      text: `Only that leg: the ${s.delta.toFixed(2)}-delta call (up) or put (down) of that expiry, ${s.sizePct}% of the account. Its mid at least $${s.minPrice.toFixed(2)}${s.minVolume > 0 ? ` and ${s.minVolume} contracts traded in the last 30 minutes` : ""}.${thinWords}`,
    },
    {
      name: "Sell",
      text: `When the stock gives back ${s.giveBackUnits} of its typical 30-minute move from its best since the buy (its high for a call, its low for a put)${s.exitOnMinuteClose ? ", on minute closes" : ""}${s.noStopMinutes > 0 ? `, not in the first ${s.noStopMinutes} minutes after the buy` : ""}; everything out by ${clockOf(s.endMinute)}.`,
    },
    {
      name: "Limits",
      text: `At most ${s.maxTradesPerDay} trades a day and ${s.maxOpen} open; no new trade after a ${s.dayLossPct}% day loss. Every buy carries the broker's safety stop at −${s.safetyStopPct}% and passes the account's risk rules.`,
    },
  ];
}
