// The bot's state for the website (docs/tasks/backend-indi-bot.md): what the
// trading service answers at GET /v1/bot, read with the read-only token.

import type { BotBroker, BotSettings } from "./bot/settings.js";
import {
  controlAccess,
  type ControlConfig,
  type Identity,
} from "./control-api.js";

export interface BotView {
  enabled: boolean;
  mode: "dry" | "live";
  // The brokers the bot can trade at (docs/tasks/backend-bot-ibkr.md); the
  // chosen one is `settings.broker`. Absent from a trading service before it.
  brokers?: BotBroker[];
  sizePct: number;
  delta: number;
  // The version of the rules in force (bot/versions.ts): "2.1", "2.1*" when
  // the owner changed its rules, or the owner's own label. Absent before versions.
  version?: string;
  // All the owner's settings (absent from a trading service before them).
  settings?: BotSettings;
  universe: string[];
  favorites: { name: string; tickers: string[]; at: number } | null;
  watching: string[]; // today's stocks: the list and the favorites
  lastRun: number | null; // the bot's last check (ms)
  day: string;
  // The news filter's sources today: off (not set up), pending, ok, or failed (no filter).
  news?: {
    earnings: "off" | "pending" | "ok" | "failed";
    premarket: "off" | "pending" | "ok" | "failed";
  };
  // Where each stock stands now: side, t-stat (|t|), volume ratio, and
  // whether the news filter keeps it out today.
  scan: {
    symbol: string;
    side: "C" | "P";
    t: number;
    rvol: number;
    minute: number;
    blocked?: "earnings" | "premarket" | null;
  }[];
  activity: {
    at: number;
    kind: "info" | "signal" | "skip" | "order" | "error";
    text: string;
  }[];
  signals: {
    day: string;
    symbol: string;
    right: "C" | "P";
    minute: number;
    t: number;
    rvol: number;
    outcome: string;
    detail: string;
    at: number;
    version?: string; // the bot version in force; absent before versions
  }[];
  // The signals that entered a position in the last sessions (the same window
  // as `positions`), for a closed trade's story. Absent from an older service.
  entries?: BotView["signals"];
  positions: {
    id: string;
    day: string;
    symbol: string;
    contract: string;
    right: "C" | "P";
    qty: number;
    bought: number;
    cost: number;
    // The entry: session minute and the stock's price then.
    entryMinute?: number;
    entryStock?: number;
    nights: number;
    status: "buying" | "open" | "closed";
    dry: boolean;
    version?: string; // the bot version that entered it; absent before versions
    // `price`: the sale's average fill (the mid in a dry run); absent on
    // sales from before it was kept.
    sales: { at: number; qty: number; reason: string; price?: number }[];
    // The level watched on the entry day for the failed-break sale (absent
    // before it, or with no level ahead).
    breakWatch?: {
      name: string;
      level: number;
      unit?: number; // the stock's unit in dollars (a typical 30-minute move)
      state: "watching" | "broken" | "ended" | "failed";
      touch: number | null;
      at: number | null;
    } | null;
    openedAt: number;
    closedAt: number | null;
  }[];
}

export async function handleBotStatus(
  trader: { url?: string; token?: string },
  fetcher: typeof fetch = fetch,
): Promise<{ status: number; body: BotView | { error: string } }> {
  if (!trader.url || !trader.token)
    return {
      status: 503,
      body: { error: "The trading service is not configured for this site" },
    };
  try {
    const response = await fetcher(new URL("/v1/bot", trader.url), {
      headers: { Authorization: `Bearer ${trader.token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      return {
        status: 502,
        body: { error: `The trading service answered ${response.status}` },
      };
    return { status: 200, body: (await response.json()) as BotView };
  } catch {
    return {
      status: 502,
      body: { error: "The trading service is unreachable" },
    };
  }
}

/**
 * The user's favorites list (user 2026-10-21: "watch also the tickers I have
 * in my favorite watchlist"): the list named in BOT_WATCHLIST, or else the
 * first whose name says favorite (or carries a star).
 */
export function favoritesList<T extends { name: string; builtIn?: true }>(
  lists: readonly T[],
  named?: string,
): T | undefined {
  const own = lists.filter((l) => !l.builtIn);
  if (named)
    return own.find((l) => l.name.toLowerCase() === named.toLowerCase());
  return own.find((l) => /fav|⭐|★/i.test(l.name));
}

/**
 * Whether the bot's copy of the favorites list is missing or differs from the
 * site's list, so the site sends it again.
 */
export function favoritesStale(
  held: { name: string; tickers: string[] } | null,
  list: { name: string; tickers: string[] },
): boolean {
  if (!held) return true;
  if (held.name !== list.name) return true;
  const a = [...held.tickers].sort().join(",");
  const b = [...list.tickers].sort().join(",");
  return a !== b;
}

/** Sends the favorites list to the bot (worker cron, and the Bot tab when the bot's copy is stale). */
export async function pushFavorites(
  trader: { url?: string; token?: string },
  list: { name: string; tickers: string[] },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (!trader.url || !trader.token)
    return "the trading service is not configured";
  const response = await fetcher(new URL("/v1/bot/watchlist", trader.url), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${trader.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: list.name, tickers: list.tickers }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return `the trading service answered ${response.status}`;
  return `sent "${list.name}" (${list.tickers.length} stocks)`;
}

/**
 * The bot's settings for the site (docs/tasks/backend-bot-settings.md). GET
 * reads them with the read-only token; PUT is the account owner's only, from
 * the site itself, and is passed on with the full token. The trading service
 * checks every value again.
 */
export async function handleBotSettings(
  config: ControlConfig & { readToken?: string | undefined },
  identity: Identity,
  request: {
    method: string;
    body?: unknown;
    origin: string;
    requestOrigin: string | null;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ status: number; body: unknown }> {
  const reading = request.method === "GET";
  if (!reading && request.method !== "PUT")
    return { status: 405, body: { error: "Method not allowed" } };
  let token = config.readToken ?? config.token;
  if (!reading) {
    const access = controlAccess(config, identity);
    if (!access.canTrade)
      return { status: 403, body: { error: access.reason } };
    if (request.requestOrigin !== request.origin)
      return {
        status: 403,
        body: { error: "This request did not come from the site itself" },
      };
    token = config.token;
  }
  if (!config.url || !token)
    return {
      status: 503,
      body: { error: "The trading service is not configured for this site" },
    };
  try {
    const response = await fetcher(new URL("/v1/bot/settings", config.url), {
      method: request.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(reading ? {} : { "Content-Type": "application/json" }),
      },
      ...(reading ? {} : { body: JSON.stringify(request.body ?? {}) }),
      signal: AbortSignal.timeout(15000),
    });
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    if (response.ok) return { status: 200, body };
    // A refused value comes back as the trading service's own words.
    if (response.status === 400)
      return { status: 400, body: { error: body?.error ?? "Not valid" } };
    return {
      status: 502,
      body: { error: `The trading service answered ${response.status}` },
    };
  } catch {
    return {
      status: 502,
      body: { error: "The trading service is unreachable" },
    };
  }
}
