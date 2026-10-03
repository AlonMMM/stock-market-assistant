import { lazy, Suspense, useState } from "react";
import type { BacktestAlert } from "../../../packages/market-data/src/backtest.js";
import type {
  Outcome,
  ValidationConfig,
} from "../../../packages/market-data/src/outcome.js";
import { AlertEvidence } from "./AlertFeed.js";
import {
  dayGoodLabel,
  filterOutcome,
  outcomeCounts,
  type OutcomeFilter,
  signedPercent,
  shownSign,
} from "./backtest-model.js";
import {
  alertDirection,
  groupAlertDays,
  symbolCounts,
  type AlertSort,
} from "./live-model.js";
import { israelClock, israelLabel } from "./time.js";

const DayChart = lazy(() =>
  import("./DayChart.js").then((m) => ({ default: m.DayChart })),
);

const sessionTag = { pre: "Pre", regular: "", post: "After" };
const outcomeName = {
  good: "Good",
  stopped: "Stopped",
  weak: "Weak",
  unscored: "Not scored",
};

function Chevron() {
  return (
    <svg
      className="chevron"
      width="14"
      height="14"
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

function OutcomeLine({ outcome: o }: { outcome: Outcome }) {
  if (o.result === "unscored")
    return <p className="evidence">Not scored: {o.reason}.</p>;
  return (
    <p className="evidence">
      <strong>
        {o.result === "good"
          ? `Good: ran the good level in ${o.minutes} min`
          : o.result === "stopped"
            ? `Stopped after ${o.minutes} min`
            : "Weak: neither level within the horizon"}
      </strong>{" "}
      · entry ${o.entry?.toFixed(2)}
      {o.entryAt && ` at ${israelClock(Date.parse(o.entryAt))}`} · u = ±
      {o.unit?.toFixed(2)}% · best {signedPercent(o.run)} (
      {o.runUnits?.toFixed(1)}
      u) · worst {signedPercent(o.pullback)} · after 5/15/30/60 min:{" "}
      {signedPercent(o.forward[5])} / {signedPercent(o.forward[15])} /{" "}
      {signedPercent(o.forward[30])} / {signedPercent(o.forward[60])}
    </p>
  );
}

/** Backtest alerts: the Live feed layout plus outcome filter and columns. */
export function BacktestAlerts({
  alerts,
  benchmarks = {},
  scoring,
  symbol,
  onSymbol,
}: {
  alerts: BacktestAlert[];
  benchmarks?: Record<string, string>;
  scoring: ValidationConfig;
  symbol: string | null;
  onSymbol: (s: string | null) => void;
}) {
  const [filter, setFilter] = useState<OutcomeFilter>("all");
  const [sort, setSort] = useState<AlertSort>("time");
  const [open, setOpen] = useState<string | null>(null);
  const [dayOpen, setDayOpen] = useState<Record<string, boolean>>({});

  const symbols = symbolCounts(alerts);
  const counts = outcomeCounts(alerts, symbol);
  const days = groupAlertDays(
    filterOutcome(
      alerts.filter((a) => !symbol || a.ticker === symbol),
      filter,
    ),
    sort,
  );
  const isDayOpen = (day: string) => dayOpen[day] ?? day === days[0]?.day;

  return (
    <>
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Outcome">
          {(
            [
              ["all", "All"],
              ["good", "Good"],
              ["stopped", "Stopped"],
              ["weak", "Weak"],
            ] as const
          ).map(([key, label]) => (
            <button
              type="button"
              key={key}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {label} <span className="count">{counts[key]}</span>
            </button>
          ))}
        </div>
        <label className="inline-field">
          Symbol
          <select
            value={symbol ?? ""}
            onChange={(e) => onSymbol(e.target.value || null)}
          >
            <option value="">All symbols</option>
            {symbols.map(([t, n]) => (
              <option key={t} value={t}>
                {t} ({n})
              </option>
            ))}
          </select>
        </label>
        {symbol && (
          <button
            type="button"
            className="filter-chip"
            aria-label={`Clear symbol filter ${symbol}`}
            onClick={() => onSymbol(null)}
          >
            {symbol} <span aria-hidden="true">×</span>
          </button>
        )}
        <span className="toolbar-gap" />
        <label className="inline-field">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as AlertSort)}
          >
            <option value="time">Newest first</option>
            <option value="ratio">Highest volume ratio</option>
            <option value="run">Best run</option>
          </select>
        </label>
      </div>

      <div className="alert-table backtest-alerts">
        <div className="alert-head" aria-hidden="true">
          <span>Time</span>
          <span>Symbol</span>
          <span>Move</span>
          <span>Vol</span>
          <span>Outcome</span>
          <span>Best run · after 15 / 60 min</span>
          <span />
        </div>
        {days.map((d) => {
          const expandedDay = isDayOpen(d.day);
          const rows = d.groups.flatMap((g) => g.rows);
          return (
            <section className="alert-day" key={d.day}>
              <button
                type="button"
                className="alert-day-head"
                aria-expanded={expandedDay}
                aria-controls={`bt-day-${d.day}`}
                onClick={() =>
                  setDayOpen({ ...dayOpen, [d.day]: !expandedDay })
                }
              >
                <Chevron />
                <strong>{d.label}</strong>
                <span>{dayGoodLabel(rows)}</span>
              </button>
              {expandedDay && (
                <div id={`bt-day-${d.day}`}>
                  {d.groups.map((g) => (
                    <section
                      key={g.key}
                      aria-label={g.title ? `${g.title} ${g.sub}` : undefined}
                    >
                      {g.title && (
                        <h4 className="alert-group">
                          {g.title}{" "}
                          <span>
                            {g.sub} · {g.rows.length}{" "}
                            {g.rows.length === 1 ? "alert" : "alerts"}
                          </span>
                        </h4>
                      )}
                      <ul>
                        {g.rows.map((a) => {
                          const key = a.ticker + a.end;
                          const expanded = open === key;
                          const direction = alertDirection(a);
                          const up = direction === "up";
                          const o = a.outcome;
                          const tag =
                            sort !== "time" ? sessionTag[a.session] : "";
                          return (
                            <li key={key}>
                              <button
                                type="button"
                                className={
                                  expanded ? "alert-row open" : "alert-row"
                                }
                                aria-expanded={expanded}
                                onClick={() => setOpen(expanded ? null : key)}
                              >
                                <span className="alert-time">
                                  {israelClock(Date.parse(a.end))}
                                </span>
                                <span className="alert-symbol">
                                  <strong>{a.ticker}</strong>
                                  {a.inPlay && (
                                    <span
                                      className="tag in-play"
                                      title={`In play: day volume ${a.dayRvol?.toFixed(1) ?? "—"}× usual`}
                                    >
                                      In play
                                    </span>
                                  )}
                                  {tag && <span className="tag">{tag}</span>}
                                </span>
                                <span
                                  className={
                                    up ? "move-tag up" : "move-tag down"
                                  }
                                >
                                  {up ? "▲" : "▼"} {signedPercent(a.move)}
                                </span>
                                <strong className="alert-vol">
                                  {a.ratio === null
                                    ? "—"
                                    : `${a.ratio.toFixed(1)}×`}
                                </strong>
                                <span
                                  className={`outcome-tag ${o.result}`}
                                  title={o.reason}
                                >
                                  {outcomeName[o.result]}
                                </span>
                                <span className="alert-run">
                                  {o.runUnits === null
                                    ? "—"
                                    : `${o.runUnits.toFixed(1)}u · ${signedPercent(o.forward[15])} / ${signedPercent(o.forward[60])}`}
                                </span>
                                <Chevron />
                              </button>
                              {expanded && (
                                <div className="alert-detail">
                                  <AlertEvidence alert={a} />
                                  <OutcomeLine outcome={o} />
                                  <Suspense
                                    fallback={
                                      <p className="chart-status">
                                        Loading day chart…
                                      </p>
                                    }
                                  >
                                    <DayChart
                                      ticker={a.ticker}
                                      alertEnd={a.end}
                                      window={a.config.window}
                                      sector={benchmarks[a.ticker]}
                                      outcome={o}
                                      direction={direction}
                                      units={scoring}
                                    />
                                  </Suspense>
                                  {symbol !== a.ticker && (
                                    <div className="actions">
                                      <button
                                        type="button"
                                        className="action"
                                        onClick={() => onSymbol(a.ticker)}
                                      >
                                        Only {a.ticker} alerts
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </section>
          );
        })}
        {days.length === 0 && (
          <p className="table-empty">No alerts match these filters.</p>
        )}
      </div>
      <p className="table-note">
        Times in {israelLabel}. Vol: the alert&apos;s volume ratio (window
        volume ÷ expected volume). Outcome: good = ran {scoring.goodUnits}u in
        the alert&apos;s direction first, stopped = {scoring.stopUnits}u against
        first, weak = neither within {scoring.horizon} min. Best run: the best
        close in the alert&apos;s direction, in u; then the move after 15 and 60
        min. In play: the symbol&apos;s day volume was well above usual.
      </p>
    </>
  );
}
