import { useState, type ReactNode } from "react";
import type {
  BacktestResult,
  BacktestAlert,
} from "../../../packages/market-data/src/backtest.js";
import { number, readJson } from "./api.js";
import { Notices } from "./Notices.js";
import { summarize } from "../../../packages/market-data/src/outcome.js";
import { AlertFeed } from "./AlertFeed.js";
import { ValidationCard } from "./Validation.js";
import { savedTickers, useWatchlist, Watchlist } from "./Watchlist.js";

// Each request stays within Cloudflare's per-request subrequest and CPU limits:
// a symbol needs about four minute-bar pages plus one daily page.
const batchSize = 6;

function merge(parts: BacktestResult[]): BacktestResult {
  const [first] = parts;
  const alerts = parts.flatMap((p) => p.alerts);
  // Medians cannot be combined across batches: recompute from all alerts and
  // add up the baseline counts.
  const validation = summarize(
    alerts.map((a) => a.outcome),
    [],
    first!.validation.config,
  );
  for (const p of parts)
    for (const k of ["scored", "good", "stopped", "weak"] as const)
      validation.baseline[k] += p.validation.baseline[k];
  const diagnostics: Record<string, number> = {};
  for (const p of parts)
    for (const [k, n] of Object.entries(p.diagnostics))
      diagnostics[k] = (diagnostics[k] ?? 0) + n;
  return {
    ...first!,
    tickers: parts.flatMap((p) => p.tickers),
    evaluated: parts.reduce((n, p) => n + p.evaluated, 0),
    alerts,
    diagnostics,
    validation,
    cache: parts.some((p) => p.cache)
      ? {
          hits: parts.reduce((n, p) => n + (p.cache?.hits ?? 0), 0),
          misses: parts.reduce((n, p) => n + (p.cache?.misses ?? 0), 0),
        }
      : undefined,
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
  const [priceMultiple, setPriceMultiple] = useState(3);
  const [minMove, setMinMove] = useState(0.5);
  const [lastMove, setLastMove] = useState(0);
  const [directionBars, setDirectionBars] = useState(3);
  const [pace, setPace] = useState(3);
  const [stopUnits, setStopUnits] = useState(1);
  const [goodUnits, setGoodUnits] = useState(2);
  const [horizon, setHorizon] = useState(60);
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
            config: {
              threshold,
              minVolume: minimum,
              cooldown,
              priceMultiple,
              minMovePercent: minMove,
              lastBarMinMovePercent: lastMove,
              directionBars,
              paceMultiple: pace,
            },
            validation: { stopUnits, goodUnits, horizon },
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
        {modes}
      </header>
      <Notices
        items={[
          ...gaps.map(
            (c) =>
              `${c.ticker}: no bars for ${c.missingSessions.join(", ")}; later baselines that need them are marked insufficient.`,
          ),
          ...failed.map((f) => `${f.tickers.join(", ")}: ${f.error}`),
          ...(watchlist.error ? [watchlist.error] : []),
          ...(error ? [error] : []),
        ]}
      />
      <h2 className="section-title">
        Backtest{" "}
        <small>alerts the bot would have sent · Alpaca SIP history</small>
      </h2>
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
          {numberInput("Volume (× typical)", threshold, setThreshold, {
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
          {numberInput(
            "Price move (× typical)",
            priceMultiple,
            setPriceMultiple,
            {
              min: "1",
              step: "0.1",
            },
          )}
          {numberInput("Minimum move (%)", minMove, setMinMove, {
            min: "0",
            max: "100",
            step: "0.05",
          })}
          {numberInput("Last minute move (%, 0 = off)", lastMove, setLastMove, {
            min: "0",
            max: "100",
            step: "0.05",
          })}
          {numberInput(
            "Same-direction candles",
            directionBars,
            setDirectionBars,
            {
              min: "1",
              max: "3",
              step: "1",
            },
          )}
          {numberInput(
            "Validation: stop (u against)",
            stopUnits,
            setStopUnits,
            {
              min: "0.1",
              step: "0.1",
            },
          )}
          {numberInput(
            "Validation: good (u in favour)",
            goodUnits,
            setGoodUnits,
            {
              min: "0.1",
              step: "0.1",
            },
          )}
          {numberInput("Validation: horizon (min)", horizon, setHorizon, {
            min: "1",
            max: "390",
            step: "1",
          })}
          {numberInput("Today's pace (×, 0 = off)", pace, setPace, {
            min: "0",
            step: "0.1",
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
            {result.alerts.length === 0 && (
              <p className="notice">No alerts matched these settings.</p>
            )}
            {result.alerts.length > 0 && (
              <ValidationCard summary={result.validation} />
            )}
            {result.alerts.length > 0 && (
              <AlertFeed
                alerts={result.alerts}
                benchmarks={watchlist.list?.benchmarks}
              />
            )}
            <details>
              <summary>Data quality &amp; suppressed signals</summary>
              <p>{number(result.evaluated)} complete windows evaluated.</p>
              {result.cache && (
                <p>
                  Bar cache: {number(result.cache.hits)} symbol-days from the
                  cache, {number(result.cache.misses)} fetched from Alpaca.
                </p>
              )}
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
