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
  maxTradesPerDay: 5,
  maxPerStock: 2,
  maxOpen: 3,
  dayLossPct: 5,
  safetyStopPct: 70,
  firstMinute: 10,
  nextDay: true,
  lastMinute: 209,
  delta: 0.35,
  minPrice: 0.2,
  minVolume: 200,
  confirmUnits: 0.25,
  // 10, not the backtest's first 60 (user 2026-10-26, "implement the 10 minutes give up";
  // leg_entry.py: a side after 10 minutes loses on both lists).
  waitMinutes: 10,
  giveBackUnits: 0.75,
  endMinute: 360,
  strengthFilter: false,
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
  // One buy a trade; the account's rules allow ten a day.
  maxTradesPerDay: [1, 10, 1],
  maxPerStock: [1, 5, 1],
  maxOpen: [1, 10, 1],
  dayLossPct: [1, 15, 0.5],
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
  "strengthFilter",
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
  const news = [
    s.skipEarnings && "the stock's earnings reaction day",
    s.skipPremarket && "a pre-market volume of 4× normal or more",
  ].filter(Boolean);
  return [
    {
      name: "The alert",
      text: `On a day with a same-day expiry${nextDayWords}, from ${clockOf(s.firstMinute)} to ${clockOf(s.lastMinute)} New York, when a volume alert fires on a stock, in either direction${perStockWords}.`,
    },
    {
      name: "News filter",
      text: news.length ? `No trade on ${news.join(" or ")}.` : "Off.",
    },
    {
      name: "The side",
      text: `Wait until the stock has moved ${s.confirmUnits} of its typical 30-minute move from where it was at the alert, up or down${s.strengthFilter ? ", with the stock's strength vs SPY × β since the open pointing the same way" : ""}. No side within ${s.waitMinutes} minutes: no trade.`,
    },
    {
      name: "Buy",
      text: `Only that leg: the ${s.delta.toFixed(2)}-delta call (up) or put (down) of that expiry, ${s.sizePct}% of the account. Its mid at least $${s.minPrice.toFixed(2)}${s.minVolume > 0 ? ` and ${s.minVolume} contracts traded in the last 30 minutes` : ""}.`,
    },
    {
      name: "Sell",
      text: `When the stock gives back ${s.giveBackUnits} of its typical 30-minute move from its best since the buy (its high for a call, its low for a put); everything out by ${clockOf(s.endMinute)}.`,
    },
    {
      name: "Limits",
      text: `At most ${s.maxTradesPerDay} trades a day and ${s.maxOpen} open; no new trade after a ${s.dayLossPct}% day loss. Every buy carries the broker's safety stop at −${s.safetyStopPct}% and passes the account's risk rules.`,
    },
  ];
}
