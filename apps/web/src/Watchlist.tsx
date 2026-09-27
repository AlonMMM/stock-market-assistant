import { useState } from "react";
import defaults from "../../../config/alpaca-watchlist.json";

export const maxTickers = 40;
const storageKey = "sma.backtest.tickers.v1";
const symbol = /^[A-Z][A-Z0-9. -]{0,9}$/;

// The selection is a per-device convenience; storage can be unavailable.
export function savedTickers(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (
      Array.isArray(saved) &&
      saved.every((t) => typeof t === "string" && symbol.test(t))
    )
      return saved.slice(0, maxTickers);
  } catch {
    // Fall through to the default selection.
  }
  return defaults.slice(0, 30);
}

function save(tickers: string[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(tickers));
  } catch {
    // Not persisted; the selection still works for this visit.
  }
}

export function Watchlist({
  selected,
  onChange,
  disabled,
}: {
  selected: string[];
  onChange: (tickers: string[]) => void;
  disabled: boolean;
}) {
  const [extra, setExtra] = useState("");
  const universe = [
    ...defaults,
    ...selected.filter((t) => !defaults.includes(t)),
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
