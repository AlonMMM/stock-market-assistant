import { useEffect, useState } from "react";
import type { Watchlist as WatchlistData } from "../../../packages/market-data/src/watchlist.js";
import { israelDateTime } from "./time.js";

export const maxTickers = 40;
const storageKey = "sma.backtest.tickers.v2";
const symbol = /^[A-Z][A-Z0-9. -]{0,9}$/;

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
      saved.every((t) => typeof t === "string" && symbol.test(t))
    )
      return saved.filter((t) => universe.includes(t)).slice(0, maxTickers);
  } catch {
    // Fall through to the default selection.
  }
  return universe.slice(0, maxTickers);
}

function save(tickers: string[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(tickers));
  } catch {
    // Not persisted; the selection still works for this visit.
  }
}

export function Watchlist({
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
  const [extra, setExtra] = useState("");
  const universe = [
    ...list.tickers,
    ...selected.filter((t) => !list.tickers.includes(t)),
  ];
  const set = (tickers: string[]) => {
    save(tickers);
    onChange(tickers);
  };
  const toggle = (t: string) =>
    set(
      selected.includes(t)
        ? selected.filter((x) => x !== t)
        : selected.length < maxTickers
          ? [...selected, t]
          : selected,
    );
  const add = () => {
    const t = extra.trim().toUpperCase();
    if (symbol.test(t) && !selected.includes(t) && selected.length < maxTickers)
      set([...selected, t]);
    setExtra("");
  };
  return (
    <fieldset className="watchlist" disabled={disabled}>
      <legend>
        Symbols · {selected.length} of max {maxTickers}
      </legend>
      <p className="watchlist-source">
        {list.source === "ibkr"
          ? `IBKR “${list.name}” · ${list.tickers.length} symbols${
              list.syncedAt
                ? ` · synced ${israelDateTime(Date.parse(list.syncedAt))}`
                : ""
            }`
          : "Default list · IBKR watchlist not synced"}
      </p>
      <div className="watchlist-actions">
        <button
          type="button"
          onClick={() => set(universe.slice(0, maxTickers))}
        >
          First {maxTickers}
        </button>
        <button type="button" onClick={() => set([])}>
          Clear
        </button>
        <input
          aria-label="Add symbol"
          placeholder="Add symbol"
          value={extra}
          autoCapitalize="characters"
          onChange={(e) => setExtra(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" onClick={add}>
          Add
        </button>
      </div>
      <div className="chips">
        {universe.map((t) => (
          <button
            type="button"
            key={t}
            className="chip"
            aria-pressed={selected.includes(t)}
            onClick={() => toggle(t)}
          >
            {t}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
