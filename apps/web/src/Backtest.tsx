import { useRef, useState, type ReactNode } from "react";
import type { BacktestResult } from "../../../packages/market-data/src/backtest.js";
import type { LiveStatus } from "../../../packages/market-data/src/live.js";
import { validationDefaults } from "../../../packages/market-data/src/outcome.js";
import { readJson } from "./api.js";
import {
  batches,
  changeBadge,
  datePreset,
  datePresetCounts,
  isSettingsError,
  lastSessions,
  liveSettings,
  maxSessions,
  maxTickers,
  mergeResults,
  rangeLabel,
  requestKey,
  ruleChanges,
  ruleGroups,
  ruleLabel,
  ruleSummary,
  sessionCount,
  setupSummary,
  symbolsPerBatch,
  type FailedBatch,
  type RuleSettings,
  type RunRequest,
} from "./backtest-model.js";
import { ResultTabs, Verdict } from "./BacktestResults.js";
import { LookNowCard } from "./LookNow.js";
import { usePolling } from "./Live.js";
import { pillFor } from "./live-model.js";
import { StatusPill } from "./StatusPill.js";
import { SymbolSelector } from "./SymbolSelector.js";
import {
  saveTickers,
  savedTickers,
  useBacktestList,
  useWatchlist,
} from "./Watchlist.js";

const liveRefreshMs = 30000;
const tradeKey = "sma.backtest.tradeView.v1";

type Scoring = RunRequest["validation"];
const scoringDefaults: Scoring = {
  stopUnits: validationDefaults.stopUnits,
  goodUnits: validationDefaults.goodUnits,
  horizon: validationDefaults.horizon,
};
const scoringFields = [
  ["goodUnits", "Good (u)", "0.1", "50", "0.1"],
  ["stopUnits", "Stop (u)", "0.1", "20", "0.1"],
  ["horizon", "Horizon (min)", "1", "390", "1"],
] as const;

/** Runs one batch; throws with the server's or a transport message. */
async function runBatch(
  request: RunRequest,
  tickers: string[],
): Promise<BacktestResult> {
  try {
    const response = await fetch("/api/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tickers,
        from: request.from,
        to: request.to,
        config: request.config,
        validation: request.validation,
      }),
      signal: AbortSignal.timeout(120000),
    });
    return await readJson<BacktestResult>(response);
  } catch (e) {
    throw new Error(
      e instanceof Error && e.name === "TimeoutError"
        ? "Timed out"
        : e instanceof Error
          ? e.message
          : "Backtest failed",
    );
  }
}

function Chevron({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="chevron"
      width={size}
      height={size}
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path
        d="M3 4.5l3 3 3-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function Card({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const id = `card-${title.toLowerCase()}`;
  return (
    <section className="card setup-card" aria-labelledby={id}>
      <div className="card-head">
        <h2 id={id}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const numberValue = (n: number) => (Number.isNaN(n) ? "" : n);
const parseNumber = (s: string) => (s === "" ? NaN : Number(s));

export function Backtest({ modes }: { modes: ReactNode }) {
  const watchlist = useWatchlist();
  const [warnings, setWarnings] = useState<string[]>([]);
  const warn = (message: string) =>
    setWarnings((w) => (w.at(-1) === message ? w : [...w, message]));
  const live = usePolling<LiveStatus>("/api/live", liveRefreshMs, warn);
  const now = Date.now();
  const pill = pillFor(live.value, now, live.at);

  // Symbols on offer: the shared backtest list plus the live watchlist.
  const backtestList = useBacktestList();
  const universe = watchlist.list
    ? [
        ...new Set([
          ...(backtestList.list?.tickers ?? []),
          ...watchlist.list.tickers,
        ]),
      ]
    : [];
  const [tickers, setTickersState] = useState<string[]>([]);
  const [loadedList, setLoadedList] = useState(false);
  if (watchlist.list && backtestList.list !== null && !loadedList) {
    setLoadedList(true);
    // Nothing saved on this device: start with the live watchlist.
    setTickersState(savedTickers(universe, watchlist.list.tickers));
  }
  const setTickers = (t: string[]) => {
    saveTickers(t);
    setTickersState(t);
  };

  const [initialRange] = useState(
    () => lastSessions(5, Date.now()) ?? { from: "", to: "" },
  );
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const fromInput = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<RuleSettings>(liveSettings);
  const [customOpen, setCustomOpen] = useState(false);
  const [scoring, setScoring] = useState<Scoring>(scoringDefaults);

  const [result, setResult] = useState<BacktestResult | null>(null);
  const [ranWith, setRanWith] = useState<RunRequest | null>(null);
  const [runId, setRunId] = useState(0);
  const [busy, setBusy] = useState<"" | "run" | "retry">("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState("");
  const [failed, setFailed] = useState<FailedBatch[]>([]);
  // Phone layout: expanded before the first run, collapsed after a run.
  const [setupOpen, setSetupOpen] = useState(true);
  const form = useRef<HTMLFormElement>(null);
  // The secondary trade view stays as the viewer left it for this visit.
  const [tradeOpen, setTradeOpenState] = useState(() => {
    try {
      return sessionStorage.getItem(tradeKey) === "open";
    } catch {
      return false;
    }
  });
  const setTradeOpen = (open: boolean) => {
    setTradeOpenState(open);
    try {
      sessionStorage.setItem(tradeKey, open ? "open" : "closed");
    } catch {
      // Remembered while the page stays mounted.
    }
  };

  const request: RunRequest = {
    tickers,
    from,
    to,
    config: settings,
    validation: scoring,
  };
  const changes = ruleChanges(settings);
  const sessions = sessionCount(from, to);
  const batchSize = symbolsPerBatch(sessions ?? 1);
  const hasRun = ranWith !== null && (result !== null || failed.length > 0);
  const stale = hasRun && requestKey(ranWith) !== requestKey(request);
  const alerted = live.value
    ? [...new Set(live.value.alerts.map((a) => a.ticker))]
    : null;
  const activeDates = datePreset(from, to, now);

  async function execute(
    run: RunRequest,
    groups: string[][],
    previous: BacktestResult | null,
  ) {
    const parts: BacktestResult[] = previous ? [previous] : [];
    const failures: FailedBatch[] = [];
    const total = groups.reduce((n, g) => n + g.length, 0);
    let done = 0;
    setProgress({ done, total });
    for (const batch of groups) {
      try {
        parts.push(await runBatch(run, batch));
      } catch (e) {
        const message = (e as Error).message;
        // Invalid settings fail every batch identically: stop and say so.
        if (isSettingsError(message)) {
          setError(message);
          setSetupOpen(true);
          return null;
        }
        failures.push({ tickers: batch, error: message });
        warn(`Backtest batch ${batch.join(", ")}: ${message}`);
      }
      done += batch.length;
      setProgress({ done, total });
    }
    return { merged: parts.length ? mergeResults(parts) : null, failures };
  }

  async function run() {
    if (!form.current?.checkValidity()) {
      setSetupOpen(true);
      setCustomOpen(true);
      requestAnimationFrame(() => form.current?.reportValidity());
      setError("Fix the highlighted setting before running.");
      return;
    }
    const dateError =
      sessions === null
        ? "Dates must fall within the 2024–2028 exchange calendar."
        : sessions < 1
          ? "The range contains no US trading sessions."
          : sessions > maxSessions
            ? `Choose at most ${maxSessions} sessions.`
            : "";
    if (dateError) {
      setSetupOpen(true);
      setError(dateError);
      return;
    }
    const snapshot: RunRequest = {
      tickers: [...tickers],
      from,
      to,
      config: { ...settings },
      validation: { ...scoring },
    };
    setBusy("run");
    setError("");
    setSetupOpen(false);
    const outcome = await execute(
      snapshot,
      batches(snapshot.tickers, batchSize),
      null,
    );
    setBusy("");
    if (!outcome) return;
    setRunId((n) => n + 1);
    setRanWith(snapshot);
    setResult(outcome.merged);
    setFailed(outcome.failures);
    if (!outcome.merged)
      setError(
        `Every batch failed (${outcome.failures[0]?.error ?? "unknown error"}). See Data quality.`,
      );
  }

  // Reruns only the failed batches with the original run's settings and
  // merges them into the result.
  async function retry() {
    if (!ranWith || !failed.length) return;
    setBusy("retry");
    setError("");
    const outcome = await execute(
      ranWith,
      failed.map((f) => f.tickers),
      result,
    );
    setBusy("");
    if (!outcome) return;
    setResult(outcome.merged);
    setFailed(outcome.failures);
  }

  function download() {
    if (!result) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `rvol-backtest-${result.from}-${result.to}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const disabled = busy !== "";
  const resultChanges = ranWith ? ruleChanges(ranWith.config).length : 0;
  const symbolsWithAlerts = result
    ? new Set(result.alerts.map((a) => a.ticker)).size
    : 0;

  return (
    <div className="backtest-page">
      <header>
        <div className="brand-status">
          <span className="brand">
            SMA<span className="brand-dot">.</span>
          </span>
          <StatusPill
            pill={pill}
            status={live.value}
            checkedAt={live.at}
            refreshSeconds={liveRefreshMs / 1000}
            warnings={warnings}
            onClearWarnings={() => setWarnings([])}
          />
        </div>
        {modes}
      </header>

      <div className="backtest-layout">
        <form
          ref={form}
          className="setup"
          aria-label="Backtest setup"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <div className="setup-intro">
            <h1>Backtest</h1>
            <p>
              Replays Alpaca SIP minute bars through the live rule. A signal
              check, not a profitability test.
            </p>
          </div>
          <button
            type="button"
            className="setup-toggle"
            aria-expanded={setupOpen}
            aria-controls="setup-cards"
            onClick={() => setSetupOpen(!setupOpen)}
          >
            <span>
              {setupSummary(tickers.length, sessions, changes.length)}
            </span>
            <Chevron />
          </button>
          <fieldset
            id="setup-cards"
            className={setupOpen ? "setup-cards" : "setup-cards collapsed"}
            disabled={disabled}
          >
            <legend className="sr-only">Setup</legend>
            <Card
              title="Symbols"
              aside={
                <span className="muted">
                  {tickers.length} selected · max {maxTickers}
                </span>
              }
            >
              {watchlist.error && (
                <p className="notice error">{watchlist.error}</p>
              )}
              {backtestList.error && (
                <p className="notice error">{backtestList.error}</p>
              )}
              {!watchlist.list && !watchlist.error && (
                <p className="muted">Loading watchlist…</p>
              )}
              {watchlist.list && (
                <SymbolSelector
                  list={backtestList.list}
                  watchlist={watchlist.list}
                  alerted={alerted}
                  selected={tickers}
                  onChange={setTickers}
                  onChangeList={backtestList.change}
                  disabled={disabled}
                />
              )}
            </Card>

            <Card
              title="Dates"
              aside={
                <span className="muted">US sessions · max {maxSessions}</span>
              }
            >
              <div
                className="preset-chips"
                role="group"
                aria-label="Date presets"
              >
                {datePresetCounts.map((n) => {
                  const range = lastSessions(n, now);
                  return (
                    <button
                      type="button"
                      key={n}
                      className="chip"
                      aria-pressed={activeDates === n}
                      disabled={!range}
                      title={
                        range
                          ? `${range.from} to ${range.to} (US session dates)`
                          : "Outside the exchange calendar"
                      }
                      onClick={() => {
                        if (!range) return;
                        setFrom(range.from);
                        setTo(range.to);
                      }}
                    >
                      Last {n} sessions
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="chip"
                  aria-pressed={activeDates === "custom"}
                  title="Choose From and To below"
                  onClick={() => fromInput.current?.focus()}
                >
                  Custom
                </button>
              </div>
              <div className="date-row">
                <label>
                  From
                  <input
                    ref={fromInput}
                    required
                    type="date"
                    value={from}
                    max={to}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <label>
                  To
                  <input
                    required
                    type="date"
                    value={to}
                    min={from}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </label>
              </div>
              <p className="muted small">
                {sessions === null
                  ? "Outside the 2024–2028 exchange calendar."
                  : `${sessions} ${sessions === 1 ? "session" : "sessions"}${sessions > 0 ? ` · ${rangeLabel(from, to)}` : ""}${sessions > maxSessions ? ` — more than ${maxSessions}` : ""}`}
              </p>
            </Card>

            <Card
              title="Rule"
              aside={
                <span
                  className={
                    changes.length ? "rule-badge changed" : "rule-badge"
                  }
                >
                  {changeBadge(changes.length)}
                </span>
              }
            >
              <p className="rule-summary">
                <strong>Live rule (rvol-v4):</strong> {ruleSummary()}
              </p>
              <button
                type="button"
                className="disclosure"
                aria-expanded={customOpen}
                aria-controls="rule-fields"
                onClick={() => setCustomOpen(!customOpen)}
              >
                Customize rule
                <Chevron size={12} />
              </button>
              <div
                id="rule-fields"
                hidden={!customOpen}
                className="rule-fields"
              >
                {ruleGroups.map((g) => (
                  <fieldset key={g.title} className="rule-group">
                    <legend>{g.title}</legend>
                    {g.fields.map((f) => {
                      const changed = settings[f.key] !== liveSettings[f.key];
                      return (
                        <label
                          key={f.key}
                          className={
                            changed ? "rule-field changed" : "rule-field"
                          }
                        >
                          <span>
                            {f.label}
                            {changed ? (
                              <em className="live-hint">
                                {" "}
                                · live {liveSettings[f.key]}
                              </em>
                            ) : (
                              f.hint && (
                                <span className="hint"> · {f.hint}</span>
                              )
                            )}
                          </span>
                          <input
                            required
                            type="number"
                            inputMode="decimal"
                            min={f.min}
                            max={f.max}
                            step={f.step}
                            value={numberValue(settings[f.key])}
                            onChange={(e) =>
                              setSettings({
                                ...settings,
                                [f.key]: parseNumber(e.target.value),
                              })
                            }
                          />
                        </label>
                      );
                    })}
                  </fieldset>
                ))}
                <button
                  type="button"
                  className="reset"
                  disabled={changes.length === 0}
                  onClick={() => setSettings(liveSettings)}
                >
                  Reset to live settings
                </button>
              </div>
            </Card>

            <Card title="Scoring">
              <p className="rule-summary">
                Enter the next minute. <strong>Good</strong> if it runs{" "}
                {numberValue(scoring.goodUnits)}u in the alert&apos;s direction
                first, <strong>stopped</strong> at{" "}
                {numberValue(scoring.stopUnits)}u against, <strong>weak</strong>{" "}
                if neither within {numberValue(scoring.horizon)} min. u = the
                symbol&apos;s typical {validationDefaults.unitMinutes}-min move
                at that time of day.
              </p>
              <div className="scoring-row">
                {scoringFields.map(([key, label, min, max, step]) => (
                  <label key={key}>
                    {label}
                    <input
                      required
                      type="number"
                      inputMode="decimal"
                      min={min}
                      max={max}
                      step={step}
                      value={numberValue(scoring[key])}
                      onChange={(e) =>
                        setScoring({
                          ...scoring,
                          [key]: parseNumber(e.target.value),
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            </Card>
          </fieldset>

          <div className="run-block">
            <button
              className="run"
              type="submit"
              disabled={disabled || tickers.length === 0}
            >
              {busy === "run"
                ? `Running… ${progress.done} / ${progress.total} symbols`
                : busy === "retry"
                  ? `Retrying… ${progress.done} / ${progress.total} symbols`
                  : `Run backtest · ${tickers.length} ${tickers.length === 1 ? "symbol" : "symbols"}${sessions ? ` · ${sessions} ${sessions === 1 ? "session" : "sessions"}` : ""}`}
            </button>
            {busy && (
              <div
                className="progress"
                role="progressbar"
                aria-label={
                  busy === "retry" ? "Retry progress" : "Backtest progress"
                }
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.done}
                aria-valuetext={`${progress.done} of ${progress.total} symbols`}
              >
                <span
                  style={{
                    width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
                  }}
                />
              </div>
            )}
            {error && (
              <p className="run-error" role="alert">
                {error}
              </p>
            )}
            <p className="muted small">
              Runs in batches of {batchSize} symbols; about 10 s per batch on a
              cold cache.
            </p>
          </div>
        </form>

        <section
          className="results-column"
          aria-label="Results"
          aria-busy={busy !== ""}
        >
          {stale && (
            <p className="stale" role="status">
              <strong>Settings changed — run again.</strong> These results are
              for the previous settings.
            </p>
          )}
          {!hasRun && (
            <div className="card empty-results">
              {busy ? (
                <p>
                  Downloading minute bars and 20 warmup sessions from Alpaca ·{" "}
                  {progress.done} of {progress.total} symbols done…
                </p>
              ) : (
                <>
                  <h2>What a run shows</h2>
                  <ul>
                    <li>
                      <strong>Look-now score</strong>: how unusual the
                      market-adjusted move after the alerts was for each stock,
                      against random minutes of the same run.
                    </li>
                    <li>
                      <strong>Trade view</strong> (secondary): how often a
                      stop/target entry ran to the good level, was stopped or
                      stayed weak, compared with ordinary momentum entries.
                    </li>
                    <li>
                      <strong>Alerts</strong>: every alert the rule would have
                      sent, grouped by Israel day, with its score and day chart.
                    </li>
                    <li>
                      <strong>By symbol</strong>: which symbols the rule works
                      on, by average score, with the trade view beside it.
                    </li>
                    <li>
                      <strong>Data quality</strong>: why windows did not alert,
                      missing data and failed batches.
                    </li>
                  </ul>
                </>
              )}
            </div>
          )}
          {hasRun && (
            <>
              <div className="result-title">
                <h2>
                  {result
                    ? `${result.alerts.length} ${result.alerts.length === 1 ? "alert" : "alerts"}`
                    : "No results"}{" "}
                  <small>
                    · {symbolsWithAlerts} of {ranWith.tickers.length} symbols ·{" "}
                    {rangeLabel(ranWith.from, ranWith.to)} ·{" "}
                    {ruleLabel(resultChanges)}
                  </small>
                </h2>
                {result && (
                  <button type="button" className="action" onClick={download}>
                    Download JSON
                  </button>
                )}
              </div>
              {result && result.alerts.length > 0 && result.lookNow && (
                <LookNowCard summary={result.lookNow} />
              )}
              {result && result.alerts.length > 0 && (
                <details
                  className="trade-view"
                  open={tradeOpen}
                  onToggle={(e) => setTradeOpen(e.currentTarget.open)}
                >
                  <summary>
                    <Chevron />
                    Trade view: stop / target vs baseline
                  </summary>
                  <Verdict result={result} alertsCount={result.alerts.length} />
                </details>
              )}
              {result && result.alerts.length === 0 && (
                <p className="card no-alerts">
                  No alerts matched these settings{" "}
                  <span
                    className={
                      resultChanges ? "rule-badge changed" : "rule-badge"
                    }
                  >
                    {changeBadge(resultChanges)}
                  </span>
                </p>
              )}
              <ResultTabs
                key={runId}
                result={result}
                failed={failed}
                retrying={busy === "retry"}
                onRetry={() => void retry()}
                benchmarks={watchlist.list?.benchmarks}
              />
            </>
          )}
        </section>
      </div>
      <footer>
        Alpaca SIP historical data replayed through the live evaluator. Signal
        reconstruction, not a profitability backtest. Times in Israel time;
        dates in the setup are US session dates.
      </footer>
    </div>
  );
}
