// The alert strangle's settings (docs/tasks/backend-strangle-bot.md): a
// second bot, separate from the Indi bot, on its own Alpaca paper account
// (user 2026-10-25: "create another test with this strategy and test it - not
// mix them ... edit the settings and see the trades in our app"). The
// defaults are the rule backtested in `zero9.py` (research/indi-v2,
// docs/research/best-algorithms.md, "The strangle").

export interface StrangleSettings {
  enabled: boolean;
  mode: "live" | "dry";
  // Stocks: the favorites list (sent by the site before each session) and
  // the owner's own, less those turned off.
  followFavorites: boolean;
  added: string[];
  off: string[];
  // Size: both legs together cost this share of the account.
  sizePct: number;
  maxTradesPerDay: number;
  maxOpen: number;
  dayLossPct: number;
  // The broker's stop on every leg, % under its cost, in case the service is
  // down. The owner's risk rules refuse a buy while a contract has no stop;
  // the trail and the wrong-leg sale act long before it.
  safetyStopPct: number;
  // Entry: the first volume alert of the day, from firstMinute to lastMinute
  // (session minutes, 09:30 New York = 0), on days with a same-day expiry.
  firstMinute: number;
  lastMinute: number;
  delta: number;
  minPrice: number; // each leg's mid
  minVolume: number; // each leg's contracts in the last 30 minutes
  // The side: the stock moves this many typical 30-minute moves from the fill.
  confirmUnits: number;
  waitMinutes: number; // no side by then: both legs out
  // The wrong leg's money buys more of the right one (the "D bonus").
  recycle: boolean;
  // The kept leg: sold when it closes this % under its high since kept.
  trailPct: number;
  endMinute: number; // everything out by then (15:30 = 360)
  // Optional: only trades where the stock's strength vs SPY x beta since the
  // open points the way of the kept side (a steadier, smaller version).
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
  maxTradesPerDay: 3,
  maxOpen: 3,
  dayLossPct: 5,
  safetyStopPct: 70,
  firstMinute: 10,
  lastMinute: 209,
  delta: 0.35,
  minPrice: 0.2,
  minVolume: 200,
  confirmUnits: 0.25,
  waitMinutes: 60,
  recycle: true,
  trailPct: 30,
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
  // Three buys a trade (two legs and the recycled buy), ten a day per account.
  maxTradesPerDay: [1, 3, 1],
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
  trailPct: [10, 60, 5],
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
  "recycle",
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
  const steps = [
    {
      name: "Entry",
      text: `On a day with a same-day expiry, from ${clockOf(s.firstMinute)} to ${clockOf(s.lastMinute)} New York, the first time the volume alert fires on a stock, in either direction. One trade per stock a day.`,
    },
    {
      name: "News filter",
      text:
        [
          s.skipEarnings && "the stock's earnings reaction day",
          s.skipPremarket && "a pre-market volume of 4× normal or more",
        ]
          .filter(Boolean)
          .join(" or ") === ""
          ? "Off."
          : `No entry on ${[s.skipEarnings && "the stock's earnings reaction day", s.skipPremarket && "a pre-market volume of 4× normal or more"].filter(Boolean).join(" or ")}.`,
    },
    {
      name: "Buy",
      text: `The ${s.delta.toFixed(2)}-delta call and put of that expiry, the same number of each, both legs together ${s.sizePct}% of the account. Each leg's mid at least $${s.minPrice.toFixed(2)}${s.minVolume > 0 ? ` and ${s.minVolume} contracts traded in the last 30 minutes` : ""}.`,
    },
    {
      name: "The side",
      text: `When the stock has moved ${s.confirmUnits} of its typical 30-minute move from the fill, that is the side${s.strengthFilter ? ", taken only when the stock's strength vs SPY × β since the open points the same way (else both legs out)" : ""}. No side within ${s.waitMinutes} minutes: both legs out.`,
    },
    {
      name: "The wrong leg",
      text: s.recycle
        ? "Sold at once, and its money buys more of the right leg."
        : "Sold at once; the money stays in cash.",
    },
    {
      name: "The right leg",
      text: `Sold when it closes ${s.trailPct}% under its highest close since it was kept; everything out by ${clockOf(s.endMinute)}.`,
    },
    {
      name: "Limits",
      text: `At most ${s.maxTradesPerDay} trades a day and ${s.maxOpen} open; no new trade after a ${s.dayLossPct}% day loss. Every leg carries the broker's safety stop at −${s.safetyStopPct}%, and every order passes the account's risk rules.`,
    },
  ];
  return steps;
}
