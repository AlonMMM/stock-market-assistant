import { useEffect, useState } from "react";
import type { Watchlist as WatchlistData } from "../../../packages/market-data/src/watchlist.js";
import { maxTickers, symbolPattern } from "./backtest-model.js";
import { readJson } from "./api.js";
import { israelDateTime } from "./time.js";

const storageKey = "sma.backtest.tickers.v2";
export { symbolPattern };

/**
 * The backtest symbol list, shared on the server (not per device). `tickers`
 * is null while loading; `change` adds and removes symbols and returns the
 * updated list.
 */
export function useBacktestList() {
  const [tickers, setTickers] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/backtest/symbols", { signal: AbortSignal.timeout(15000) })
      .then((r) => readJson<{ tickers: string[] }>(r))
      .then((body) => setTickers(body.tickers))
      .catch((e: Error) => {
        setError(`Backtest list unavailable: ${e.message}`);
        setTickers([]);
      });
  }, []);
  async function change(add: string[], remove: string[]) {
    const response = await fetch("/api/backtest/symbols", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ add, remove }),
    });
    const body = await readJson<{ tickers: string[] }>(response);
    setTickers(body.tickers);
    return body.tickers;
  }
  return { tickers, error, change };
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

export function savedTickers(universe: string[]): string[] {
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
  return universe.slice(0, maxTickers);
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

/** Chip picker over the watchlist plus any added symbols. */
export function SymbolPicker({
  list,
  selected,
  onChange,
  disabled,
}: {
  list: WatchlistData;
  selected: string[];
  onChange: (tickers: string[]) => void;
  disabled: boolean;
}) {
  const universe = [
    ...list.tickers,
    ...selected.filter((t) => !list.tickers.includes(t)),
  ];
  const full = selected.length >= maxTickers;
  return (
    <fieldset className="symbol-picker" disabled={disabled}>
      <legend className="sr-only">Selected symbols</legend>
      <div className="chips">
        {universe.map((t) => {
          const on = selected.includes(t);
          return (
            <button
              type="button"
              key={t}
              className="chip"
              aria-pressed={on}
              disabled={!on && full}
              onClick={() =>
                onChange(
                  on ? selected.filter((x) => x !== t) : [...selected, t],
                )
              }
            >
              {t}
            </button>
          );
        })}
      </div>
      <div className="picker-actions">
        <button type="button" className="action" onClick={() => onChange([])}>
          Clear selection
        </button>
        {full && <span className="muted">Maximum {maxTickers} reached.</span>}
      </div>
    </fieldset>
  );
}
