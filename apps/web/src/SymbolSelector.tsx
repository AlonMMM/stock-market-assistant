import { useState } from "react";
import type { Watchlist as WatchlistData } from "../../../packages/market-data/src/watchlist.js";
import {
  filterSymbols,
  knownEtfs,
  maxTickers,
  parseSymbols,
  previewTickers,
  sectorGroups,
  symbolGroups,
} from "./backtest-model.js";
import { watchlistSource, type BacktestList } from "./Watchlist.js";

type Kind = "stock" | "etf";

/**
 * The Symbols card body: quick picks, a search box that also adds new symbols
 * to the shared backtest list, and separate Stocks and ETFs sections. In edit
 * mode, list symbols can be removed from the list.
 */
export function SymbolSelector({
  list,
  watchlist,
  alerted,
  selected,
  onChange,
  onChangeList,
  disabled,
}: {
  list: BacktestList | null;
  watchlist: WatchlistData;
  alerted: string[] | null; // null while live alerts load
  selected: string[];
  onChange: (tickers: string[]) => void;
  onChangeList: (add: string[], remove: string[], kind: Kind) => Promise<void>;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>("stock");
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const groups = symbolGroups(list, watchlist);
  const all = [...groups.stocks, ...groups.etfs];
  const sectors = sectorGroups(watchlist).map((g) => ({
    ...g,
    tickers: g.tickers.filter((s) => all.includes(s)),
  }));
  const listed = new Set(list?.tickers ?? []);
  const typed = parseSymbols(query);
  // Typed words: exact symbols, search prefixes of existing symbols, and new
  // symbols (no match at all), which are offered for adding to the list.
  const exact = typed.valid.filter((t) => all.includes(t));
  const unknown = typed.valid.filter((t) => !all.includes(t));
  const prefixes = unknown.filter((w) => all.some((t) => t.startsWith(w)));
  const fresh = unknown.filter((w) => !prefixes.includes(w));
  const select = (tickers: string[]) => {
    const next = [...new Set(tickers)];
    onChange(next.slice(0, maxTickers));
    setMessage(
      next.length > maxTickers
        ? `Only the first ${maxTickers} were selected (the maximum).`
        : "",
    );
  };
  const toggle = (t: string) =>
    select(
      selected.includes(t) ? selected.filter((x) => x !== t) : [...selected, t],
    );

  // Enter / Add: adds the new symbols (or `words`) to the list and selects
  // them with the exact matches; with nothing new, Enter selects the exact
  // matches. Search prefixes alone do nothing.
  async function addTyped(words = fresh) {
    if (typed.invalid.length) {
      setMessage(`Not US symbols: ${typed.invalid.join(", ")}.`);
      return;
    }
    if (!words.length) {
      if (exact.length) {
        select([...selected, ...exact]);
        setQuery("");
      }
      return;
    }
    setBusy(true);
    try {
      await onChangeList(words, [], kind);
      select([...selected, ...exact, ...words]);
      setQuery("");
      setKind("stock");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(t: string) {
    setBusy(true);
    try {
      await onChangeList([], [t], "stock");
      onChange(selected.filter((x) => x !== t));
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const quick: { label: string; tickers: string[]; reason?: string }[] = [
    { label: "All stocks", tickers: groups.stocks },
    { label: "All ETFs", tickers: groups.etfs },
    {
      label: "Watchlist",
      tickers: watchlist.tickers.filter((s) => all.includes(s)),
    },
    {
      label: "Alerted",
      tickers: (alerted ?? []).filter((s) => all.includes(s)),
      reason:
        alerted === null
          ? "Loading live alerts"
          : alerted.length
            ? undefined
            : "No recent live alerts",
    },
  ];
  const same = (a: string[]) =>
    a.length > 0 &&
    a.length === selected.length &&
    a.every((t) => selected.includes(t));

  return (
    <div className="symbol-selector">
      <div className="quick-picks" role="group" aria-label="Quick picks">
        {quick.map((q) => (
          <button
            type="button"
            key={q.label}
            className="chip"
            aria-pressed={same(q.tickers)}
            disabled={disabled || !!q.reason || !q.tickers.length}
            title={q.reason ?? `${q.tickers.length} symbols`}
            onClick={() => select(q.tickers)}
          >
            {q.label} <span className="count">{q.tickers.length}</span>
          </button>
        ))}
        {sectors.length > 0 && (
          <select
            className="sector-pick"
            aria-label="Select a sector"
            value=""
            disabled={disabled}
            onChange={(e) => {
              const group = sectors.find((s) => s.etf === e.target.value);
              if (group) select(group.tickers);
            }}
          >
            <option value="">By sector…</option>
            {sectors.map((s) => (
              <option key={s.etf} value={s.etf}>
                {s.etf} · {s.tickers.length} symbols
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="chip"
          disabled={disabled || !selected.length}
          onClick={() => select([])}
        >
          Clear
        </button>
      </div>

      <p className="preview">{previewTickers(selected)}</p>
      <label className="symbol-search">
        <span className="sr-only">Search or add symbols</span>
        <input
          type="search"
          value={query}
          placeholder="Search or add symbols, e.g. ARM, TSM"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-describedby="symbol-message"
          onChange={(e) => {
            const value = e.target.value;
            setQuery(value);
            setMessage("");
            const words = parseSymbols(value).valid;
            if (words.length && words.every((t) => knownEtfs.has(t)))
              setKind("etf");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void addTyped();
            }
          }}
        />
      </label>
      {fresh.length > 0 && !typed.invalid.length && (
        <div className="add-new">
          <span>
            Add <strong>{fresh.join(", ")}</strong> to the list as
          </span>
          <div className="segmented small" role="group" aria-label="Kind">
            {(["stock", "etf"] as const).map((k) => (
              <button
                type="button"
                key={k}
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
              >
                {k === "stock" ? "Stock" : "ETF"}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="action primary"
            disabled={busy || disabled}
            onClick={() => void addTyped()}
          >
            Add
          </button>
        </div>
      )}
      {prefixes.length > 0 && !fresh.length && !typed.invalid.length && (
        <p className="muted small">
          Searching for {prefixes.join(", ")}…{" "}
          <button
            type="button"
            className="link"
            disabled={busy || disabled}
            onClick={() => void addTyped(prefixes)}
          >
            add {prefixes.join(", ")} as a new{" "}
            {prefixes.length > 1 ? "symbols" : "symbol"}
          </button>
        </p>
      )}
      {message && (
        <p id="symbol-message" className="field-error" role="alert">
          {message}
        </p>
      )}

      {(
        [
          ["Stocks", groups.stocks],
          ["ETFs", groups.etfs],
        ] as const
      ).map(([title, symbols]) => {
        const shown = filterSymbols(symbols, query);
        const picked = symbols.filter((t) => selected.includes(t)).length;
        return (
          <div className="sym-kind" key={title} role="group" aria-label={title}>
            <div className="sym-kind-head">
              <span className="sym-kind-title">
                {title}{" "}
                <span className="muted">
                  {picked} of {symbols.length} selected
                </span>
              </span>
              <div className="group-actions">
                <button
                  type="button"
                  className="link"
                  disabled={disabled || !shown.length}
                  onClick={() => select([...selected, ...shown])}
                >
                  {query ? "Select matches" : "Select all"}
                </button>
                <button
                  type="button"
                  className="link"
                  disabled={disabled || !picked}
                  onClick={() =>
                    onChange(selected.filter((t) => !shown.includes(t)))
                  }
                >
                  None
                </button>
              </div>
            </div>
            {shown.length ? (
              <div className="chips">
                {shown.map((t) =>
                  editing && listed.has(t) ? (
                    <span className="chip removable" key={t}>
                      {t}
                      <button
                        type="button"
                        aria-label={`Remove ${t} from the list`}
                        disabled={busy}
                        onClick={() => void remove(t)}
                      >
                        ×
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      key={t}
                      className="chip"
                      aria-pressed={!editing && selected.includes(t)}
                      disabled={
                        disabled ||
                        editing ||
                        (!selected.includes(t) && selected.length >= maxTickers)
                      }
                      onClick={() => toggle(t)}
                    >
                      {t}
                    </button>
                  ),
                )}
              </div>
            ) : (
              <p className="muted small">
                {query ? "No matches." : `No ${title.toLowerCase()} yet.`}
              </p>
            )}
          </div>
        );
      })}

      <div className="symbol-footer">
        <button
          type="button"
          className="action"
          aria-pressed={editing}
          disabled={disabled}
          onClick={() => setEditing(!editing)}
        >
          {editing ? "Done editing" : "Edit list"}
        </button>
        <span className="muted small">
          {editing
            ? "× removes a symbol from the shared list and the live engine."
            : `${list?.tickers.length ?? "…"} symbols in the shared list · watchlist: ${watchlistSource(watchlist)} · selection saved on this device`}
        </span>
      </div>
    </div>
  );
}
