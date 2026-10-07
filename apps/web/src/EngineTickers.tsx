import { useState } from "react";
import { parseSymbols } from "./backtest-model.js";
import { useBacktestList } from "./Watchlist.js";

/** The shared ticker list controls both live alerts and available backtests. */
export function EngineTickers() {
  const { list, error, change } = useBacktestList();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"stock" | "etf">("stock");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [syncFailed, setSyncFailed] = useState(false);

  async function update(add: string[], remove: string[]) {
    setBusy(true);
    setMessage("");
    try {
      await change(add, remove, kind);
      setSyncFailed(false);
      setMessage(
        remove.length
          ? `Removed ${remove.join(", ")} from the engine.`
          : add.length
            ? `Added ${add.join(", ")} to the engine.`
            : "Engine tickers synced.",
      );
      if (add.length) setInput("");
    } catch (e) {
      const message = (e as Error).message;
      setMessage(message);
      setSyncFailed(message.includes("collector sync failed"));
    } finally {
      setBusy(false);
    }
  }

  const typed = parseSymbols(input);
  const shown = (list?.tickers ?? []).filter((t) =>
    t.includes(query.trim().toUpperCase()),
  );
  return (
    <details className="engine-tickers">
      <summary>Manage engine tickers ({list?.tickers.length ?? "…"})</summary>
      <p className="preview">
        Add or remove tickers for live alerts and backtests. Removed tickers
        stop producing new alerts; past alerts stay visible.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <form
        className="engine-ticker-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || !list || error) return;
          if (typed.invalid.length) {
            setMessage(`Not US symbols: ${typed.invalid.join(", ")}.`);
            return;
          }
          const add = typed.valid.filter((t) => !list.tickers.includes(t));
          if (!add.length) {
            setMessage(
              typed.valid.length
                ? "These tickers are already listed."
                : "Enter at least one ticker.",
            );
            return;
          }
          void update(add, []);
        }}
      >
        <label className="symbol-search">
          <span>Add tickers</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="AAPL, AMD, TSM"
            disabled={busy || !list || !!error}
          />
        </label>
        <label>
          <span>Type</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "stock" | "etf")}
            disabled={busy || !list || !!error}
          >
            <option value="stock">Stock</option>
            <option value="etf">ETF</option>
          </select>
        </label>
        <button
          type="submit"
          className="action"
          disabled={busy || !list || !!error || !input.trim()}
        >
          {busy ? "Updating…" : "Add to engine"}
        </button>
      </form>
      <label className="symbol-search">
        <span>Find monitored ticker</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter tickers"
        />
      </label>
      <div className="chips" aria-label="Engine tickers">
        {shown.map((t) => (
          <button
            key={t}
            type="button"
            className="chip"
            aria-label={`Remove ${t} from engine`}
            disabled={busy || !!error}
            onClick={() => void update([], [t])}
          >
            {t}
            {list?.etfs.includes(t) ? " · ETF" : ""} ×
          </button>
        ))}
      </div>
      {list && !shown.length && (
        <p className="preview">
          {list.tickers.length
            ? "No matching tickers."
            : "No tickers monitored. Add a ticker to start."}
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <button
        type="button"
        className="action"
        disabled={busy || !list || !!error}
        onClick={() => void update([], [])}
      >
        {syncFailed ? "Retry engine sync" : "Sync engine"}
      </button>
    </details>
  );
}
