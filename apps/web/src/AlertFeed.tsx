import { lazy, Suspense, useEffect, useState } from "react";
import type { Evaluation } from "../../../packages/alerts/src/relative-volume.js";
import type { AlertContext } from "../../../packages/market-data/src/backtest.js";
import type { LiveAnalysis } from "../../../packages/market-data/src/live.js";
import type { Outcome } from "../../../packages/market-data/src/outcome.js";
import { AnalysisPanel } from "./Analysis.js";

// Backtest alerts carry close and market context; live alerts may lack them.
export type FeedAlert = Evaluation & {
  close?: number;
  context?: AlertContext | null;
  outcome?: Outcome; // backtest only: what the price did after the alert
  analysis?: LiveAnalysis; // live only, when the collector analyzes alerts
};

const outcomeBadge = { good: "✅", stopped: "❌", weak: "⏸", unscored: "·" };
import { number } from "./api.js";
import { israelClock, israelDateTime, israelLabel } from "./time.js";

const DayChart = lazy(() =>
  import("./DayChart.js").then((m) => ({ default: m.DayChart })),
);

const signed = (n: number) => (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(1);
const sessionTag = { pre: "Pre", regular: "", post: "After" };

type Sort = "time" | "ratio";

export function AlertFeed({
  alerts,
  benchmarks = {},
  focus,
}: {
  alerts: FeedAlert[];
  benchmarks?: Record<string, string>; // sector benchmark per symbol
  focus?: string; // ticker + end of a row to open and scroll to on mount
}) {
  const [ticker, setTicker] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("time");
  const [result, setResult] = useState<Outcome["result"] | null>(null);
  const scored = alerts.some((a) => a.outcome);
  const [open, setOpen] = useState<string | null>(focus ?? null);
  useEffect(() => {
    if (focus)
      document
        .getElementById(`alert-${focus}`)
        ?.scrollIntoView({ block: "start" });
    // Only the first focus scrolls; later polls must not move the page.
  }, []);

  const counts = new Map<string, number>();
  for (const a of alerts) counts.set(a.ticker, (counts.get(a.ticker) ?? 0) + 1);
  const tickers = [...counts].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  );
  const shown = alerts
    .filter((a) => !ticker || a.ticker === ticker)
    .filter((a) => !result || a.outcome?.result === result)
    .sort((a, b) =>
      sort === "ratio"
        ? (b.ratio ?? 0) - (a.ratio ?? 0)
        : b.end.localeCompare(a.end),
    );

  return (
    <div className="feed">
      <div className="feed-filters">
        {scored && (
          <div className="chips" role="group" aria-label="Filter by outcome">
            {(
              [
                [null, "Any outcome"],
                ["good", "✅ Good"],
                ["stopped", "❌ Stopped"],
                ["weak", "⏸ Weak"],
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                key={label}
                className="chip"
                aria-pressed={result === value}
                onClick={() => setResult(value)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="chips" role="group" aria-label="Filter by symbol">
          <button
            type="button"
            className="chip"
            aria-pressed={ticker === null}
            onClick={() => setTicker(null)}
          >
            All {alerts.length}
          </button>
          {tickers.map(([t, n]) => (
            <button
              type="button"
              key={t}
              className="chip"
              aria-pressed={ticker === t}
              onClick={() => setTicker(ticker === t ? null : t)}
            >
              {t} {n}
            </button>
          ))}
        </div>
        <label className="feed-sort">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
          >
            <option value="time">Newest first</option>
            <option value="ratio">Highest ratio</option>
          </select>
        </label>
      </div>
      <p className="feed-note">
        Times in {israelLabel}.
        {alerts.some((a) => a.context) &&
          " “vs SPY×β”: the symbol’s move from the previous close minus SPY’s move times the symbol’s 60-day beta."}
      </p>
      <ul className="feed-list">
        {shown.map((a) => {
          const key = a.ticker + a.end;
          const expanded = open === key;
          const c = a.context;
          const spy = a.analysis?.result?.scores.find(
            (s) => s.kind === "market",
          );
          return (
            <li
              key={key}
              id={`alert-${key}`}
              className={expanded ? "feed-row open" : "feed-row"}
            >
              <button
                type="button"
                className="feed-summary"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : key)}
              >
                <strong className="feed-ticker">
                  {a.outcome && (
                    <span
                      className="feed-outcome"
                      title={a.outcome.reason ?? a.outcome.result}
                    >
                      {outcomeBadge[a.outcome.result]}{" "}
                    </span>
                  )}
                  {a.ticker}
                </strong>
                <span className="feed-time">
                  {israelDateTime(Date.parse(a.end))}
                  {sessionTag[a.session] && (
                    <em className="feed-session">{sessionTag[a.session]}</em>
                  )}
                </span>
                <strong className="feed-ratio">
                  {a.ratio?.toFixed(1)}×
                  {a.direction && (
                    <span
                      className={
                        a.direction === "up" ? "feed-move up" : "feed-move down"
                      }
                    >
                      {a.direction === "up" ? "▲" : "▼"}{" "}
                      {Math.abs(a.move).toFixed(2)}%
                    </span>
                  )}
                </strong>
                <span className="feed-excess">
                  {c ? (
                    <>
                      <strong>{signed(c.excess)}%</strong> vs SPY×β
                    </>
                  ) : spy?.score !== null && spy?.score !== undefined ? (
                    <>
                      <strong>{spy.score}</strong>/100 vs SPY
                    </>
                  ) : a.analysis && !a.analysis.result ? (
                    "analyzing…"
                  ) : (
                    "—"
                  )}
                </span>
                <span className="feed-chevron" aria-hidden="true">
                  {expanded ? "⌃" : "⌄"}
                </span>
              </button>
              {expanded && (
                <div className="feed-detail">
                  <p className="evidence">
                    {number(a.actual)} shares in {a.config.window} min vs{" "}
                    {number(a.expected ?? 0)} expected
                    {a.paceRatio !== null && a.paceRatio !== undefined && (
                      <> · {a.paceRatio.toFixed(1)}× today&apos;s pace</>
                    )}
                    {a.volumeBasis === "pace" && (
                      <> (volume qualified by today&apos;s pace)</>
                    )}
                    {a.expectedMove !== null &&
                      a.expectedMove !== undefined && (
                        <>
                          {" "}
                          · move {a.move >= 0 ? "+" : "−"}
                          {Math.abs(a.move).toFixed(2)}% vs typical ±
                          {a.expectedMove.toFixed(2)}% at this time
                        </>
                      )}
                    {a.close !== undefined && (
                      <> · close ${a.close.toFixed(2)}</>
                    )}
                    {c && (
                      <>
                        {" "}
                        · {a.ticker} {signed(c.change)}%, SPY{" "}
                        {signed(c.spyChange)}%, β {c.beta.toFixed(2)}
                      </>
                    )}
                  </p>
                  {a.analysis && (
                    <AnalysisPanel
                      ticker={a.ticker}
                      end={a.end}
                      direction={a.direction}
                      analysis={a.analysis}
                    />
                  )}
                  <Suspense
                    fallback={
                      <p className="chart-status">Loading day chart…</p>
                    }
                  >
                    {a.outcome && <OutcomeLine outcome={a.outcome} />}
                    <DayChart
                      ticker={a.ticker}
                      alertEnd={a.end}
                      outcome={a.outcome}
                      window={a.config.window}
                      sector={benchmarks[a.ticker]}
                    />
                  </Suspense>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function OutcomeLine({ outcome: o }: { outcome: Outcome }) {
  if (o.result === "unscored")
    return <p className="evidence">Not scored: {o.reason}.</p>;
  const f = (n: number | null) =>
    n === null ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
  return (
    <p className="evidence outcome-line">
      <strong>
        {o.result === "good"
          ? `✅ Good momentum in ${o.minutes} min`
          : o.result === "stopped"
            ? `❌ Stopped after ${o.minutes} min`
            : "⏸ Weak: no follow-through"}
      </strong>{" "}
      · entry ${o.entry?.toFixed(2)} at {israelClock(Date.parse(o.entryAt!))} ·
      u = ±{o.unit?.toFixed(2)}% · best {f(o.run)} ({o.runUnits?.toFixed(1)}u) ·
      worst {f(o.pullback)} · after 5/15/30/60 min: {f(o.forward[5])} /{" "}
      {f(o.forward[15])} / {f(o.forward[30])} / {f(o.forward[60])}
    </p>
  );
}
