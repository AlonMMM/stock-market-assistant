import fallback from "../../../config/alpaca-watchlist.json" with { type: "json" };
import { tickerPattern } from "./backtest.js";

// The user's IBKR watchlist is owned by the collector (its database), synced
// from IBKR by a scheduled Claude routine; see docs/ibkr-operations.md.
export interface Watchlist {
  source: "ibkr" | "default";
  name: string;
  syncedAt: string | null;
  tickers: string[];
  live: string[]; // subscribed to the live stream (first N)
}

export const maxWatchlist = 200;

export class WatchlistInputError extends Error {}

/** Validates a sync payload: {"name": "...", "tickers": [...]}. */
export function parseWatchlistInput(input: unknown): {
  name: string;
  tickers: string[];
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new WatchlistInputError("Expected JSON object");
  const { name, tickers } = input as { name?: unknown; tickers?: unknown };
  if (typeof name !== "string" || !name.trim() || name.length > 100)
    throw new WatchlistInputError("Expected a watchlist name");
  if (
    !Array.isArray(tickers) ||
    tickers.length < 1 ||
    tickers.length > maxWatchlist ||
    !tickers.every((t) => typeof t === "string" && tickerPattern.test(t))
  )
    throw new WatchlistInputError(
      `Expected 1–${maxWatchlist} US stock symbols`,
    );
  return { name: name.trim(), tickers: [...new Set(tickers as string[])] };
}

export function defaultWatchlist(): Watchlist {
  return {
    source: "default",
    name: "Default",
    syncedAt: null,
    tickers: fallback,
    live: [],
  };
}

export interface CollectorAccess {
  url?: string;
  token?: string;
}

/** Reads the synced list from the collector; the default list otherwise. */
export async function loadWatchlist(
  collector: CollectorAccess,
  fetcher: typeof fetch = fetch,
): Promise<Watchlist> {
  if (!collector.url || !collector.token) return defaultWatchlist();
  try {
    const response = await fetcher.call(
      globalThis,
      `${collector.url.replace(/\/+$/, "")}/watchlist`,
      {
        headers: { Authorization: `Bearer ${collector.token}` },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) return defaultWatchlist();
    const body = (await response.json()) as {
      syncedAt?: unknown;
      live?: unknown;
    };
    const { name, tickers } = parseWatchlistInput(body);
    const live = Array.isArray(body.live)
      ? body.live.filter((t): t is string => tickers.includes(t as string))
      : [];
    return {
      source: "ibkr",
      name,
      syncedAt: typeof body.syncedAt === "string" ? body.syncedAt : null,
      tickers,
      live,
    };
  } catch {
    return defaultWatchlist();
  }
}
