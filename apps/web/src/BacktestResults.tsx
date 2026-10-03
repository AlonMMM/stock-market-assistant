import { useState } from "react";
import type { BacktestResult } from "../../../packages/market-data/src/backtest.js";
import type { ValidationSummary } from "../../../packages/market-data/src/outcome.js";
import { number } from "./api.js";
import { BacktestAlerts } from "./BacktestAlerts.js";
import {
  diagnosticBars,
  minTrusted,
  qualityLabel,
  signedPoints,
  sortSymbolRows,
  symbolRows,
  unscoredReasons,
  verdictRows,
  minSymbolAlerts,
  type FailedBatch,
  type SymbolRow,
  type SymbolSort,
  signedPercent,
  shownSign,
} from "./backtest-model.js";

const pctText = (n: number | null) => (n === null ? "—" : `${n}%`);

const verdictText = {
  good: (c: ValidationSummary["config"]) => [
    "Good momentum",
    `ran ${c.goodUnits}u in the alert's direction first`,
  ],
  stopped: (c: ValidationSummary["config"]) => [
    "Stopped",
    `hit ${c.stopUnits}u against first`,
  ],
  weak: (c: ValidationSummary["config"]) => [
    "Weak",
    `neither within ${c.horizon} min`,
  ],
};

export function Verdict({
  result,
  alertsCount,
}: {
  result: BacktestResult;
  alertsCount: number;
}) {
  const s = result.validation;
  const rows = verdictRows(s);
  const reasons = unscoredReasons(result.alerts);
  return (
    <section className="card verdict" aria-labelledby="verdict-title">
      <div className="verdict-head">
        <h3 id="verdict-title">
          Did the move follow, compared with ordinary momentum entries?
        </h3>
        <span className="muted">
          {number(s.scored)} scored of {number(alertsCount)} alerts
        </span>
      </div>
      <div className="verdict-grid">
        {rows.map((r) => {
          const [label, note] = verdictText[r.key](s.config);
          return (
            <div className={`verdict-item ${r.key}`} key={r.key}>
              <div className="verdict-label">
                <strong>{label}</strong>
                {r.diff !== null && (
                  <span className={`verdict-diff ${r.tone}`}>
                    {signedPoints(r.diff)} vs baseline
                    {r.tone !== "neutral" && ` · ${r.tone}`}
                  </span>
                )}
              </div>
              <div className="pair">
                <span>Alerts</span>
                <span className="pair-track" aria-hidden="true">
                  <span style={{ width: `${r.alerts ?? 0}%` }} />
                </span>
                <strong>{pctText(r.alerts)}</strong>
                <span className="muted">Baseline</span>
                <span className="pair-track baseline" aria-hidden="true">
                  <span style={{ width: `${r.baseline ?? 0}%` }} />
                </span>
                <span className="muted">{pctText(r.baseline)}</span>
              </div>
              <span className="muted">{note}</span>
            </div>
          );
        })}
      </div>
      <div className="verdict-forward">
        <span className="muted">Median move in the alert&apos;s direction</span>
        {([5, 15, 30, 60] as const).map((m) => {
          const v = s.medianForward[m];
          return (
            <span key={m}>
              {m} min{" "}
              <strong
                className={
                  v === null || shownSign(v) === 0
                    ? ""
                    : shownSign(v) > 0
                      ? "excess up"
                      : "excess down"
                }
              >
                {signedPercent(v)}
              </strong>
            </span>
          );
        })}
        <span>
          Median best run{" "}
          <strong>
            {s.medianRunUnits === null
              ? "—"
              : `${s.medianRunUnits.toFixed(1)}u`}
          </strong>
        </span>
      </div>
      <p className="verdict-meta">
        {number(s.scored)} scored alerts
        {s.unscored > 0 &&
          ` · ${number(s.unscored)} not scored (${reasons
            .map(([r, n]) => `${r.toLowerCase()}: ${n}`)
            .join("; ")})`}{" "}
        · baseline: {number(s.baseline.scored)} momentum entries at every 5th
        regular minute in the same symbols and days, scored the same way · u =
        the symbol&apos;s typical {s.config.unitMinutes}-min move at that time
      </p>
      {s.scored < minTrusted && (
        <p className="note-amber">
          Only {s.scored} scored alerts: a difference of a few points is within
          noise. Use more symbols or sessions before changing the rule.
        </p>
      )}
    </section>
  );
}

const symbolColumns: [SymbolSort, string, string, boolean][] = [
  ["ticker", "Symbol", "", false],
  ["alerts", "Alerts", "right", false],
  ["avgScore", "Avg score", "right", false],
  ["bigShare", "Big+ %", "right", false],
  ["goodPct", "Good %", "right trade", true],
  ["vsBaseline", "vs baseline", "right trade", true],
];

export function SymbolTable({
  rows: all,
  onPick,
}: {
  rows: SymbolRow[];
  onPick: (ticker: string) => void;
}) {
  const [sort, setSort] = useState<SymbolSort>("avgScore");
  const [descending, setDescending] = useState(true);
  const rows = sortSymbolRows(all, sort, descending);
  const pick = (key: SymbolSort) => {
    if (key === sort) setDescending(!descending);
    else {
      setSort(key);
      setDescending(key !== "ticker");
    }
  };
  return (
    <>
      <div className="symbol-table">
        <div className="symbol-scroll">
          <div className="symbol-group" aria-hidden="true">
            <span>Trade view</span>
          </div>
          <div className="symbol-head" role="group" aria-label="Sort by">
            {symbolColumns.map(([key, label, align, trade]) => {
              const active = sort === key;
              return (
                <button
                  type="button"
                  key={key}
                  className={`${align}${active ? " active" : ""}`}
                  aria-pressed={active}
                  aria-label={`Sort by ${trade ? "trade view " : ""}${label}${active ? (descending ? ", highest first" : ", lowest first") : ""}`}
                  onClick={() => pick(key)}
                >
                  {label}
                  <span aria-hidden="true">
                    {active ? (descending ? " ▼" : " ▲") : ""}
                  </span>
                </button>
              );
            })}
          </div>
          <ul>
            {rows.map((r) => {
              const avg =
                r.avgScore === null ? "—" : String(Math.round(r.avgScore));
              return (
                <li key={r.ticker}>
                  <button
                    type="button"
                    className={r.small ? "symbol-row small" : "symbol-row"}
                    onClick={() => onPick(r.ticker)}
                    aria-label={`${r.ticker}: ${r.alerts} alerts, average look-now score ${avg}, ${pctText(r.bigShare)} big or very big; trade view ${pctText(r.goodPct)} good, ${r.vsBaseline === null ? "no per-symbol baseline" : `${signedPoints(r.vsBaseline)} vs baseline`}${r.small ? "; too few scored alerts to judge" : ""}. Show its alerts`}
                  >
                    <strong>{r.ticker}</strong>
                    <span className="num right">{r.alerts}</span>
                    <strong className="num right">{avg}</strong>
                    <span className="num right">{pctText(r.bigShare)}</span>
                    <span className="num right trade">
                      {pctText(r.goodPct)}
                    </span>
                    <span
                      className={
                        r.vsBaseline === null || r.vsBaseline === 0
                          ? "num right trade"
                          : `num right trade excess ${r.vsBaseline > 0 ? "up" : "down"}`
                      }
                    >
                      {r.vsBaseline === null ? "—" : signedPoints(r.vsBaseline)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <p className="table-note">
        Avg score: the mean look-now score of the symbol&apos;s scored alerts.
        Big+ %: share labelled Big (≥ 90) or Very big (≥ 97). Trade view: Good %
        of the symbol&apos;s stop/target-scored alerts, and vs baseline = that
        minus the good % of its own baseline momentum entries, in points (“—”
        when the API gives no per-symbol baseline). Rows with fewer than{" "}
        {minSymbolAlerts} look-now-scored alerts are faded and listed last: too
        few to judge. Select a row to see its alerts.
      </p>
    </>
  );
}

export function DataQuality({
  result,
  failed,
  retrying,
  onRetry,
}: {
  result: BacktestResult | null;
  failed: FailedBatch[];
  retrying: boolean;
  onRetry: () => void;
}) {
  const bars = result ? diagnosticBars(result.diagnostics) : [];
  const gaps = result?.coverage.filter((c) => c.missingSessions.length) ?? [];
  return (
    <div className="quality-grid">
      {result && (
        <section className="card">
          <h3>Why windows did not alert</h3>
          <ul className="diag-list">
            {bars.map((b) => (
              <li key={b.key}>
                <span>{b.label}</span>
                <span className="diag-track" aria-hidden="true">
                  <span style={{ width: `${b.width}%` }} />
                </span>
                <span className="num right">{number(b.count)}</span>
              </li>
            ))}
          </ul>
          <p className="muted">
            {number(result.evaluated)} complete windows evaluated. Bars on a log
            scale.
          </p>
        </section>
      )}
      <section className="card">
        <h3>Data coverage</h3>
        {result && (
          <>
            <p>
              {result.coverage.length - gaps.length} of {result.coverage.length}{" "}
              symbols complete
              {gaps.length === 0 && "."}
            </p>
            {gaps.length > 0 && (
              <ul className="gap-list">
                {gaps.map((c) => (
                  <li key={c.ticker}>
                    <strong>{c.ticker}</strong> no bars for{" "}
                    {c.missingSessions.join(", ")} (US dates); later baselines
                    that need them are marked insufficient.
                  </li>
                ))}
              </ul>
            )}
            {result.cache && (
              <p>
                Bar cache: {number(result.cache.hits)} symbol-days from the
                cache, {number(result.cache.misses)} fetched from Alpaca,{" "}
                {number(result.cache.errors ?? 0)} errors
                {(result.cache.errors ?? 0) > 0 &&
                  ` (last: ${result.cache.lastError}; results are unaffected)`}
                .
              </p>
            )}
          </>
        )}
        {failed.length === 0 ? (
          <p>No failed batches.</p>
        ) : (
          <div className="failed">
            <p>
              <strong>
                {failed.length} {failed.length === 1 ? "batch" : "batches"}{" "}
                failed
              </strong>{" "}
              — these symbols are missing from the results:
            </p>
            <ul>
              {failed.map((f) => (
                <li key={f.tickers.join()}>
                  <strong>{f.tickers.join(", ")}</strong>: {f.error}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="action"
              disabled={retrying}
              onClick={onRetry}
            >
              {retrying ? "Retrying…" : "Retry these"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export type ResultTab = "alerts" | "symbols" | "quality";

export function ResultTabs({
  result,
  failed,
  retrying,
  onRetry,
  benchmarks,
}: {
  result: BacktestResult | null;
  failed: FailedBatch[];
  retrying: boolean;
  onRetry: () => void;
  benchmarks?: Record<string, string>;
}) {
  const [tab, setTab] = useState<ResultTab>("alerts");
  const [symbol, setSymbol] = useState<string | null>(null);
  const alerts = result?.alerts ?? [];
  const rows = result
    ? symbolRows(alerts, result.validation.baselineBySymbol)
    : [];
  const tabs: [ResultTab, string, string | number][] = [
    ["alerts", "Alerts", alerts.length],
    ["symbols", "By symbol", rows.length],
    ["quality", "Data quality", qualityLabel(result, failed)],
  ];
  const keys = tabs.map(([k]) => k);
  return (
    <>
      <div
        role="tablist"
        aria-label="Result views"
        className="tabs"
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          const i = keys.indexOf(tab);
          const next =
            keys[(i + (e.key === "ArrowRight" ? 1 : keys.length - 1)) % 3]!;
          setTab(next);
          document.getElementById(`bt-tab-${next}`)?.focus();
        }}
      >
        {tabs.map(([key, label, count]) => (
          <button
            type="button"
            role="tab"
            key={key}
            id={`bt-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`bt-panel-${key}`}
            tabIndex={tab === key ? 0 : -1}
            onClick={() => setTab(key)}
          >
            {label}
            <span
              className={
                key === "quality" && count !== "OK"
                  ? "tab-count warn"
                  : "tab-count"
              }
            >
              {count}
            </span>
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id={`bt-panel-${tab}`}
        aria-labelledby={`bt-tab-${tab}`}
        className="tab-panel"
      >
        {tab === "alerts" &&
          (result && alerts.length > 0 ? (
            <BacktestAlerts
              alerts={alerts}
              benchmarks={benchmarks}
              scoring={result.validation.config}
              symbol={symbol}
              onSymbol={setSymbol}
            />
          ) : (
            <p className="notice">No alerts to show.</p>
          ))}
        {tab === "symbols" &&
          (rows.length > 0 ? (
            <SymbolTable
              rows={rows}
              onPick={(t) => {
                setSymbol(t);
                setTab("alerts");
              }}
            />
          ) : (
            <p className="notice">No symbol had alerts.</p>
          ))}
        {tab === "quality" && (
          <DataQuality
            result={result}
            failed={failed}
            retrying={retrying}
            onRetry={onRetry}
          />
        )}
      </section>
    </>
  );
}
