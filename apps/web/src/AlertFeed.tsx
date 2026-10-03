import { lazy, Suspense, useEffect, useState } from "react";
import type { Evaluation } from "../../../packages/alerts/src/relative-volume.js";
import type { AlertContext } from "../../../packages/market-data/src/backtest.js";
import type { LiveAnalysis } from "../../../packages/market-data/src/live.js";
import type { Outcome } from "../../../packages/market-data/src/outcome.js";
import type {
  LookNow,
  LookNowLabel,
} from "../../../packages/market-data/src/look-now.js";
import { LookNowBadge, LookNowLine } from "./LookNow.js";
import { AnalysisPanel } from "./Analysis.js";

// Backtest alerts carry close and market context; live alerts may lack them.
export type FeedAlert = Evaluation & {
  close?: number;
  context?: AlertContext | null;
  outcome?: Outcome; // backtest only: trade view (stop/target)
  lookNow?: LookNow; // backtest only: how unusual the move after it was
  analysis?: LiveAnalysis; // live only, when the collector analyzes alerts
};

const outcomeBadge = { good: "✅", stopped: "❌", weak: "⏸", unscored: "·" };
import { number } from "./api.js";
import { israelClock, israelDay, israelDayLabel, israelLabel } from "./time.js";

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
  const looked = alerts.some((a) => a.lookNow);
  const scored = !looked && alerts.some((a) => a.outcome);
  const [label, setLabel] = useState<LookNowLabel | null>(null);
  const [open, setOpen] = useState<string | null>(focus ?? null);
  // Days the viewer opened (true) or closed (false); other days follow the
  // default: the newest day and the linked alert's day are open.
  const [days, setDays] = useState<Record<string, boolean>>({});
  const [focusDay] = useState(() => {
    const linked = alerts.find((a) => a.ticker + a.end === focus);
    return linked && israelDay(Date.parse(linked.end));
  });
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
    .filter((a) => !label || a.lookNow?.label === label)
    .sort((a, b) =>
      sort === "ratio"
        ? (b.ratio ?? 0) - (a.ratio ?? 0)
        : b.end.localeCompare(a.end),
    );
  // One group per Israel calendar date, newest date first; rows keep the
  // chosen sort inside their date.
  const groups = new Map<string, FeedAlert[]>();
  for (const a of shown) {
    const day = israelDay(Date.parse(a.end));
    groups.set(day, [...(groups.get(day) ?? []), a]);
  }
  const dates = [...groups.keys()].sort().reverse();
  const isOpen = (day: string) =>
    days[day] ?? (day === dates[0] || day === focusDay);

  return (
    <div className="feed">
      <div className="feed-filters">
        {looked && (
          <div
            className="chips"
            role="group"
            aria-label="Filter by look-now label"
          >
            {(
              [
                [null, "Any move"],
                ["very-big", "🔥 Very big"],
                ["big", "Big"],
                ["normal", "Normal"],
              ] as const
            ).map(([value, text]) => (
              <button
                type="button"
                key={text}
                className="chip"
                aria-pressed={label === value}
                onClick={() => setLabel(value)}
              >
                {text}
              </button>
            ))}
          </div>
        )}
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
      {dates.map((day) => {
        const rows = groups.get(day)!;
        const expandedDay = isOpen(day);
        return (
          <section className="feed-day" key={day}>
            <button
              type="button"
              className="feed-day-head"
              aria-expanded={expandedDay}
              aria-controls={`day-${day}`}
              onClick={() => setDays({ ...days, [day]: !expandedDay })}
            >
              <span className="feed-day-chevron" aria-hidden="true">
                {expandedDay ? "⌄" : "›"}
              </span>
              <strong>{israelDayLabel(Date.parse(rows[0]!.end))}</strong>
              <span className="feed-day-count">
                {rows.length} {rows.length === 1 ? "alert" : "alerts"}
              </span>
            </button>
            {expandedDay && (
              <ul className="feed-list" id={`day-${day}`}>
                {rows.map((a) => {
                  const key = a.ticker + a.end;
                  const expanded = open === key;
                  const c = a.context;
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
                          {a.lookNow ? (
                            <>
                              <LookNowBadge look={a.lookNow} />{" "}
                            </>
                          ) : (
                            a.outcome && (
                              <span
                                className="feed-outcome"
                                title={a.outcome.reason ?? a.outcome.result}
                              >
                                {outcomeBadge[a.outcome.result]}{" "}
                              </span>
                            )
                          )}
                          {a.inPlay && (
                            <span
                              className="feed-inplay"
                              title={`In play: day volume ${a.dayRvol?.toFixed(1)}× usual`}
                            >
                              ⭐{" "}
                            </span>
                          )}
                          {a.ticker}
                        </strong>
                        <span className="feed-time">
                          {israelClock(Date.parse(a.end))}
                          {sessionTag[a.session] && (
                            <em className="feed-session">
                              {sessionTag[a.session]}
                            </em>
                          )}
                        </span>
                        <strong className="feed-ratio">
                          {a.ratio?.toFixed(1)}×
                          {a.direction && (
                            <span
                              className={
                                a.direction === "up"
                                  ? "feed-move up"
                                  : "feed-move down"
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
                          <AlertEvidence alert={a} />
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
                            {a.lookNow && <LookNowLine look={a.lookNow} />}
                            {a.outcome &&
                              (a.lookNow ? (
                                <details className="trade-view">
                                  <summary>
                                    Trade view (stop/target in the burst&apos;s
                                    direction)
                                  </summary>
                                  <OutcomeLine outcome={a.outcome} />
                                </details>
                              ) : (
                                <OutcomeLine outcome={a.outcome} />
                              ))}
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
            )}
          </section>
        );
      })}
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

/** One line of evidence: window volume vs expected, pace, move, context. */
export function AlertEvidence({ alert: a }: { alert: FeedAlert }) {
  const c = a.context;
  return (
    <p className="evidence">
      {number(a.actual)} shares in {a.config.window} min vs{" "}
      {number(a.expected ?? 0)} expected
      {a.paceRatio !== null && a.paceRatio !== undefined && (
        <> · {a.paceRatio.toFixed(1)}× today&apos;s pace</>
      )}
      {a.volumeBasis === "pace" && (
        <> (volume qualified by today&apos;s pace)</>
      )}
      {a.expectedMove !== null && a.expectedMove !== undefined && (
        <>
          {" "}
          · move {a.move >= 0 ? "+" : "−"}
          {Math.abs(a.move).toFixed(2)}% vs typical ±{a.expectedMove.toFixed(2)}
          % at this time
        </>
      )}
      {a.dayRvol !== null && a.dayRvol !== undefined && (
        <>
          {" "}
          · day volume {a.dayRvol.toFixed(1)}× usual{a.inPlay && " ⭐ in play"}
        </>
      )}
      {a.close !== undefined && <> · close ${a.close.toFixed(2)}</>}
      {c && (
        <>
          {" "}
          · {a.ticker} {signed(c.change)}%, SPY {signed(c.spyChange)}%, β{" "}
          {c.beta.toFixed(2)}
        </>
      )}
    </p>
  );
}
