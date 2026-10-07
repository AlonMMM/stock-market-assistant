import { useEffect, useState } from "react";
import type { Watchlist as WatchlistData } from "../../../packages/market-data/src/watchlist.js";
import { maxTickers, symbolPattern } from "./backtest-model.js";
import { readJson } from "./api.js";
import { israelDateTime } from "./time.js";

const storageKey = "sma.backtest.tickers.v2";
export { symbolPattern };

export interface BacktestList {
  tickers: string[];
  etfs: string[]; // the ETFs among tickers
}

/**
 * The backtest symbol list, shared on the server (not per device). `list` is
 * null while loading; `change` adds `add` as `kind` and removes `remove`.
 */
export function useBacktestList() {
  const [list, setList] = useState<BacktestList | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/backtest/symbols", { signal: AbortSignal.timeout(15000) })
      .then((r) => readJson<BacktestList>(r))
      .then((body) => setList({ tickers: body.tickers, etfs: body.etfs ?? [] }))
      .catch((e: Error) => {
        setError(`Ticker list unavailable: ${e.message}`);
        setList({ tickers: [], etfs: [] });
      });
  }, []);
  async function change(
    add: string[],
    remove: string[],
    kind: "stock" | "etf" = "stock",
  ) {
    const response = await fetch("/api/backtest/symbols", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ add, remove, kind }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await readJson<
      BacktestList & { live?: { synced: boolean; error?: string } }
    >(response);
    setList({ tickers: body.tickers, etfs: body.etfs ?? [] });
    if (body.live && !body.live.synced)
      throw new Error(
        `List updated, but live collector sync failed: ${body.live.error ?? "unknown error"}. Retry the change.`,
      );
  }
  return { list, error, change };
}

// The watchlist comes from the server (synced from IBKR); the selection within
// it is a per-device convenience, and storage can be unavailable.
export function useWatchlist() {
  const [list, setList] = useState<WatchlistData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/watchlist", { signal: AbortSignal.timeout(15000) })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Watchlist unavailable (${r.status})`);
        setList((await r.json()) as WatchlistData);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  return { list, error };
}

/** The saved selection within `universe`, else `fallback` (first maxTickers). */
export function savedTickers(
  universe: string[],
  fallback: string[] = universe,
): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (
      Array.isArray(saved) &&
      saved.every((t) => typeof t === "string" && symbolPattern.test(t))
    )
      return saved.filter((t) => universe.includes(t)).slice(0, maxTickers);
  } catch {
    // Fall through to the default selection.
  }
  return fallback.slice(0, maxTickers);
}

export function saveTickers(tickers: string[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(tickers));
  } catch {
    // Not persisted; the selection still works for this visit.
  }
}

/** "IBKR “Main” · 30 symbols · synced 3 Oct, 09:12". */
export function watchlistSource(list: WatchlistData): string {
  return list.source === "ibkr"
    ? `IBKR “${list.name}” · ${list.tickers.length} symbols${
        list.syncedAt
          ? ` · synced ${israelDateTime(Date.parse(list.syncedAt))}`
          : ""
      }`
    : "Default list · IBKR watchlist not synced";
}
