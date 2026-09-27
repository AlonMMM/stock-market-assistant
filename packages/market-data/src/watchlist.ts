import fallback from "../../../config/alpaca-watchlist.json" with { type: "json" };
import { tickerPattern } from "./backtest.js";

// The user's broker watchlist is account data, so it lives outside Git in the
// WATCHLIST server secret: {"name": "...", "syncedAt": "...", "tickers": [...]}.
// It is synced from IBKR on request (docs/ibkr-operations.md#watchlist-sync).
export interface Watchlist {
  source: "ibkr" | "default";
  name: string;
  syncedAt: string | null;
  tickers: string[];
}

export function readWatchlist(raw: string | undefined): Watchlist {
  try {
    const value = JSON.parse(raw ?? "null") as {
      name?: unknown;
      syncedAt?: unknown;
      tickers?: unknown;
    } | null;
    const tickers = value?.tickers;
    if (
      Array.isArray(tickers) &&
      tickers.length > 0 &&
      tickers.every((t) => typeof t === "string" && tickerPattern.test(t))
    )
      return {
        source: "ibkr",
        name: typeof value?.name === "string" ? value.name : "IBKR watchlist",
        syncedAt: typeof value?.syncedAt === "string" ? value.syncedAt : null,
        tickers: [...new Set(tickers as string[])],
      };
  } catch {
    // Invalid secret: serve the default list rather than failing the page.
  }
  return {
    source: "default",
    name: "Default",
    syncedAt: null,
    tickers: fallback,
  };
}
