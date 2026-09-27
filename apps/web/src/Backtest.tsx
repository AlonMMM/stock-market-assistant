import { useState, type ReactNode } from "react";
import type {
  BacktestResult,
  BacktestAlert,
} from "../../../packages/market-data/src/backtest.js";
import { number, readJson } from "./api.js";
import { AlertFeed } from "./AlertFeed.js";
import { savedTickers, useWatchlist, Watchlist } from "./Watchlist.js";

// Each request stays within Cloudflare's per-request subrequest and CPU limits:
// a symbol needs about four minute-bar pages plus one daily page.
const batchSize = 6;

function merge(parts: BacktestResult[]): BacktestResult {
  const [first] = parts;
  const diagnostics: Record<string, number> = {};
  for (const p of parts)
    for (const [k, n] of Object.entries(p.diagnostics))
      diagnostics[k] = (diagnostics[k] ?? 0) + n;
  return {
    ...first!,
    tickers: parts.flatMap((p) => p.tickers),
    evaluated: parts.reduce((n, p) => n + p.evaluated, 0),
    alerts: parts.flatMap((p) => p.alerts),
    diagnostics,
    coverage: parts.flatMap((p) => p.coverage),
  };
}

const day = (offset: number) =>
  new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);

export function Backtest({ modes }: { modes: ReactNode }) {
  const watchlist = useWatchlist();
  const [tickers, setTickers] = useState<string[]>([]);
  const [loadedList, setLoadedList] = useState(false);
  if (watchlist.list && !loadedList) {
    setLoadedList(true);
    setTickers(savedTickers(watchlist.list.tickers));
  }
  const [from, setFrom] = useState(day(8));
  const [to, setTo] = useState(day(1));
  const [threshold, setThreshold] = useState(3);
  const [minimum, setMinimum] = useState(10000);
  const [cooldown, setCooldown] = useState(15);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState<{ tickers: string[]; error: string }[]>(
    [],
  );
  function changed() {
    setResult(null);
    setError("");
  }
  async function run() {
    setBusy(true);
    setError("");
    setResult(null);
    setFailed([]);
    setProgress(0);
    const parts: BacktestResult[] = [];
    const failures: { tickers: string[]; error: string }[] = [];
    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);
      try {
        const response = await fetch("/api/backtest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tickers: batch,
            from,
            to,
            config: { threshold, minVolume: minimum, cooldown },
          }),
          signal: AbortSignal.timeout(120000),
        });
        parts.push(await readJson<BacktestResult>(response));
      } catch (e) {
        const message =
          e instanceof Error && e.name === "TimeoutError"
            ? "Timed out"
            : e instanceof Error
              ? e.message
              : "Backtest failed";
        // Invalid settings fail every batch identically: stop and say so.
        if (e instanceof Error && /^(Choose|Dates|The range)/.test(message)) {
          setError(message);
          setBusy(false);
          return;
        }
        failures.push({ tickers: batch, error: message });
      }
      setProgress(Math.min(i + batchSize, tickers.length));
    }
    setFailed(failures);
    if (parts.length) setResult(merge(parts));
    else setError(failures[0]?.error ?? "Backtest failed");
    setBusy(false);
  }
  function download(alerts: BacktestAlert[]) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ ...result, alerts }, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `rvol-backtest-${from}-${to}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  const numberInput = (
    label: string,
    value: number,
    set: (n: number) => void,
    attrs: { min: string; max?: string; step: string },
  ) => (
    <label>
      {label}
      <input
        required
        disabled={busy}
        type="number"
        {...attrs}
        value={value}
        onChange={(e) => {
          set(Number(e.target.value));
          changed();
        }}
      />
    </label>
  );
  const gaps = result?.coverage.filter((c) => c.missingSessions.length) ?? [];
  return (
    <>
      <header>
        <span className="brand">
          SMA<span className="brand-dot">.</span>
        </span>
        <span className="badge">ALPACA SIP HISTORY</span>
      </header>
      <h1>Relative volume</h1>
      <p className="lede">See the alerts the bot would have sent.</p>
      {modes}
      <p className="method">
        Historical Alpaca minute bars replayed through the live evaluator · up
        to 40 symbols and 20 sessions
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        {watchlist.error && <p className="notice error">{watchlist.error}</p>}
        {!watchlist.list && !watchlist.error && (
          <p className="notice">Loading watchlist…</p>
        )}
        {watchlist.list && (
          <Watchlist
            list={watchlist.list}
            selected={tickers}
            disabled={busy}
            onChange={(t) => {
              setTickers(t);
              changed();
            }}
          />
        )}
        <div className="volume-controls backtest-range">
          <label>
            From
            <input
              required
              disabled={busy}
              type="date"
              value={from}
              max={to}
              onChange={(e) => {
                setFrom(e.target.value);
                changed();
              }}
            />
          </label>
          <label>
            To
            <input
              required
              disabled={busy}
              type="date"
              value={to}
              min={from}
              onChange={(e) => {
                setTo(e.target.value);
                changed();
              }}
            />
          </label>
        </div>
        <div className="volume-controls">
          {numberInput("Alert threshold (×)", threshold, setThreshold, {
            min: "1.1",
            step: "0.1",
          })}
          {numberInput("Minimum volume", minimum, setMinimum, {
            min: "0",
            step: "1",
          })}
          {numberInput("Cooldown (min)", cooldown, setCooldown, {
            min: "0",
            max: "1440",
            step: "1",
          })}
        </div>
        <button
          className="run"
          disabled={busy || tickers.length === 0}
          type="submit"
        >
          {busy
            ? `Running… ${progress} / ${tickers.length} symbols`
            : `Run backtest · ${tickers.length} symbols`}
        </button>
      </form>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div aria-live="polite" aria-busy={busy}>
        {busy && (
          <p className="notice">
            Downloading minute bars and 20 warmup sessions from Alpaca ·{" "}
            {progress} of {tickers.length} symbols done…
          </p>
        )}
        {!result && !busy && !error && (
          <p className="notice">
            Choose symbols and dates, then run the backtest.
          </p>
        )}
        {result && (
          <section className="results">
            <div className="result-header">
              <h2>
                {result.alerts.length}{" "}
                {result.alerts.length === 1 ? "alert" : "alerts"} ·{" "}
                {new Set(result.alerts.map((a) => a.ticker)).size} of{" "}
                {result.tickers.length} symbols
              </h2>
              <button
                type="button"
                className="upload"
                onClick={() => download(result.alerts)}
              >
                ↓ Download JSON
              </button>
            </div>
            {failed.map((f) => (
              <p className="notice error" key={f.tickers.join()}>
                {f.tickers.join(", ")}: {f.error}
              </p>
            ))}
            {gaps.length > 0 && (
              <p className="notice coverage-warning">
                Missing sessions for {gaps.map((c) => c.ticker).join(", ")}.
                Later baselines that need them are marked insufficient.
              </p>
            )}
            {result.alerts.length === 0 && (
              <p className="notice">No alerts matched these settings.</p>
            )}
            {result.alerts.length > 0 && <AlertFeed alerts={result.alerts} />}
            <details>
              <summary>Data quality &amp; suppressed signals</summary>
              <p>{number(result.evaluated)} complete windows evaluated.</p>
              <ul>
                {gaps.map((c) => (
                  <li key={c.ticker + "-gaps"}>
                    {c.ticker}: no bars for {c.missingSessions.join(", ")}
                  </li>
                ))}
                {result.coverage.map((c) => (
                  <li key={c.ticker}>
                    {c.ticker}: {number(c.bars)} minute bars in range
                  </li>
                ))}
                {Object.entries(result.diagnostics).map(([s, n]) => (
                  <li key={s}>
                    {s.replaceAll("-", " ")}: {number(n)}
                  </li>
                ))}
              </ul>
            </details>
          </section>
        )}
      </div>
      <footer>
        Alpaca SIP historical data. Signal reconstruction, not a profitability
        backtest.
      </footer>
    </>
  );
}
