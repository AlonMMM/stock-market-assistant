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
  // Sector or theme benchmark per symbol (an ETF, e.g. MSTR → IBIT), chosen by
  // the syncing agent; symbols without one compare with SPY only.
  benchmarks: Record<string, string>;
}

export const maxWatchlist = 200;

export class WatchlistInputError extends Error {}

/** Validates a sync payload: {"name": "...", "tickers": [...]}. */
export function parseWatchlistInput(input: unknown): {
  name: string;
  tickers: string[];
  benchmarks: Record<string, string>;
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new WatchlistInputError("Expected JSON object");
  const { name, tickers, benchmarks } = input as {
    name?: unknown;
    tickers?: unknown;
    benchmarks?: unknown;
  };
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
  const unique = [...new Set(tickers as string[])];
  if (
    benchmarks !== undefined &&
    (!benchmarks ||
      typeof benchmarks !== "object" ||
      Array.isArray(benchmarks) ||
      !Object.entries(benchmarks).every(
        ([symbol, etf]) =>
          unique.includes(symbol) &&
          typeof etf === "string" &&
          tickerPattern.test(etf),
      ))
  )
    throw new WatchlistInputError(
      "Expected benchmarks as {symbol: benchmark symbol} for listed symbols",
    );
  return {
    name: name.trim(),
    tickers: unique,
    benchmarks: Object.fromEntries(
      Object.entries((benchmarks ?? {}) as Record<string, string>).filter(
        ([symbol, etf]) => symbol !== etf,
      ),
    ),
  };
}

export function defaultWatchlist(): Watchlist {
  return {
    source: "default",
    name: "Default",
    syncedAt: null,
    tickers: fallback,
    live: [],
    benchmarks: {},
  };
}

export interface CollectorAccess {
  url?: string;
  token?: string;
}

/** Reads the synced list from the collector; the default list otherwise. */
// Most symbols the collector streams live (the backtest list's limit).
export const maxLiveSymbols = 500;

/** Sends the symbols to stream to the collector (`PUT /live-symbols`). */
export async function pushLiveSymbols(
  collector: CollectorAccess,
  tickers: string[],
  fetcher: typeof fetch = fetch,
): Promise<{ synced: boolean; error?: string }> {
  if (!collector.url || !collector.token)
    return { synced: false, error: "Live collector is not configured" };
  try {
    const response = await fetcher.call(
      globalThis,
      `${collector.url.replace(/\/+$/, "")}/live-symbols`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${collector.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ tickers }),
        signal: AbortSignal.timeout(10000),
      },
    );
    return response.ok
      ? { synced: true }
      : { synced: false, error: `Collector answered ${response.status}` };
  } catch {
    return { synced: false, error: "Collector unreachable" };
  }
}

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
    const { name, tickers, benchmarks } = parseWatchlistInput(body);
    const live = Array.isArray(body.live)
      ? body.live.filter((t): t is string => tickers.includes(t as string))
      : [];
    return {
      source: "ibkr",
      name,
      syncedAt: typeof body.syncedAt === "string" ? body.syncedAt : null,
      tickers,
      live,
      benchmarks,
    };
  } catch {
    return defaultWatchlist();
  }
}
