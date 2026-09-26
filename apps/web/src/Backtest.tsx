import { useState, type ReactNode } from "react";
import type {
  BacktestResult,
  BacktestAlert,
} from "../../../packages/market-data/src/backtest.js";
import { AlertCard, number } from "./AlertCard.js";

const day = (offset: number) =>
  new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);

export function Backtest({ modes }: { modes: ReactNode }) {
  const [tickers, setTickers] = useState("AAPL");
  const [from, setFrom] = useState(day(8));
  const [to, setTo] = useState(day(1));
  const [threshold, setThreshold] = useState(3);
  const [minimum, setMinimum] = useState(10000);
  const [cooldown, setCooldown] = useState(15);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function changed() {
    setResult(null);
    setError("");
  }
  async function run() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tickers: tickers
            .split(/[\s,]+/)
            .map((t) => t.trim().toUpperCase())
            .filter(Boolean),
          from,
          to,
          config: { threshold, minVolume: minimum, cooldown },
        }),
        signal: AbortSignal.timeout(120000),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Backtest failed");
      setResult(payload);
    } catch (e) {
      setError(
        e instanceof Error && e.name === "TimeoutError"
          ? "The backtest took too long. Try fewer symbols or a shorter range."
          : e instanceof Error
            ? e.message
            : "Backtest failed",
      );
    } finally {
      setBusy(false);
    }
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
        to 10 symbols and 20 sessions
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="volume-controls backtest-range">
          <label className="tickers">
            Symbols (comma separated)
            <input
              required
              disabled={busy}
              value={tickers}
              autoCapitalize="characters"
              onChange={(e) => {
                setTickers(e.target.value);
                changed();
              }}
            />
          </label>
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
        <button className="run" disabled={busy} type="submit">
          {busy ? "Running…" : "Run backtest"}
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
            Downloading minute bars and 20 warmup sessions from Alpaca…
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
                {result.alerts.length === 1 ? "alert" : "alerts"} would have
                been sent
              </h2>
              <button
                type="button"
                className="upload"
                onClick={() => download(result.alerts)}
              >
                ↓ Download JSON
              </button>
            </div>
            {gaps.map((c) => (
              <p className="notice coverage-warning" key={c.ticker}>
                {c.ticker}: no bars for {c.missingSessions.join(", ")}. Later
                baselines that need these sessions are marked insufficient.
              </p>
            ))}
            {result.alerts.length === 0 && (
              <p className="notice">No alerts matched these settings.</p>
            )}
            {result.alerts.map((a) => (
              <AlertCard alert={a} key={a.ticker + a.end} />
            ))}
            <details>
              <summary>Data quality &amp; suppressed signals</summary>
              <p>{number(result.evaluated)} complete windows evaluated.</p>
              <ul>
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
