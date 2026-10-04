import { lazy, Suspense, useEffect, useState } from "react";
import { alertLink } from "../../../packages/contracts/src/alert-link.js";
import {
  AlertEvidence,
  VsSpyLine,
  VsSpyTag,
  type FeedAlert,
} from "./AlertFeed.js";
import {
  alertDirection,
  directionCounts,
  filterAlerts,
  groupAlertDays,
  symbolCounts,
  type AlertSort,
  type DirectionFilter,
} from "./live-model.js";
import { AnalysisPanel } from "./Analysis.js";
import { israelClock, israelDay, israelLabel } from "./time.js";
import {
  scoreNote,
  nowForAlert,
  scoreStrong,
  scoreWeak,
  type StrengthNow,
} from "./vs-spy-model.js";

const DayChart = lazy(() =>
  import("./DayChart.js").then((m) => ({ default: m.DayChart })),
);

const signedPct = (n: number, digits = 2) =>
  `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}%`;
const sessionTag = { pre: "Pre", regular: "", post: "After" };
/** Volume ratio bar is full at this many times expected volume. */
const ratioScale = 8;

function CopyLink({ alert }: { alert: FeedAlert }) {
  const [state, setState] = useState<"" | "Copied" | "Copy failed">("");
  useEffect(() => {
    if (!state) return;
    const t = setTimeout(() => setState(""), 2500);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      className="action"
      onClick={() =>
        navigator.clipboard
          .writeText(alertLink(`${location.origin}/`, alert))
          .then(
            () => setState("Copied"),
            () => setState("Copy failed"),
          )
      }
    >
      {state || "Copy link"}
      <span className="sr-only" aria-live="polite">
        {state}
      </span>
    </button>
  );
}

/** Live alerts: direction and symbol filters, session groups, expandable rows. */
export function LiveAlerts({
  alerts,
  benchmarks = {},
  focus,
  symbol,
  onSymbol,
  since,
  strengthNow = {},
}: {
  alerts: FeedAlert[];
  benchmarks?: Record<string, string>;
  strengthNow?: Record<string, StrengthNow>; // latest score vs SPY by ticker
  focus?: string; // ticker + end of a row to open and scroll to on mount
  symbol: string | null;
  onSymbol: (s: string | null) => void;
  since: number | null; // previous visit (ms); later alerts are "New"
}) {
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [sort, setSort] = useState<AlertSort>("time");
  const [open, setOpen] = useState<string | null>(focus ?? null);
  useEffect(() => {
    if (focus)
      document
        .getElementById(`alert-${focus}`)
        ?.scrollIntoView({ block: "start" });
    // Only the first focus scrolls; later polls must not move the page.
  }, []);

  const symbols = symbolCounts(alerts);
  const counts = directionCounts(alerts, symbol);
  const days = groupAlertDays(filterAlerts(alerts, direction, symbol), sort);
  // Days the viewer opened (true) or closed (false); other days follow the
  // default: the newest day and the linked alert's day are open. Kept
  // across polls while the tab is mounted.
  const [dayOpen, setDayOpen] = useState<Record<string, boolean>>({});
  const [focusDay] = useState(() => {
    const linked = alerts.find((a) => a.ticker + a.end === focus);
    return linked && israelDay(Date.parse(linked.end));
  });
  const isDayOpen = (day: string) =>
    dayOpen[day] ?? (day === days[0]?.day || day === focusDay);

  return (
    <>
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Direction">
          {(
            [
              ["all", "All", counts.all],
              ["up", "▲ Up", counts.up],
              ["down", "▼ Down", counts.down],
            ] as const
          ).map(([key, label, n]) => (
            <button
              type="button"
              key={key}
              aria-pressed={direction === key}
              onClick={() => setDirection(key)}
            >
              {label} <span className="count">{n}</span>
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
            {symbol && !symbols.some(([t]) => t === symbol) && (
              <option value={symbol}>{symbol} (0)</option>
            )}
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
          </select>
        </label>
      </div>

      <div className="alert-table">
        <div className="alert-head" aria-hidden="true">
          <span>Time</span>
          <span>Symbol</span>
          <span>Move</span>
          <span>Volume vs expected</span>
          <span>vs SPY at alert</span>
          <span />
        </div>
        {days.map((d) => {
          const expandedDay = isDayOpen(d.day);
          return (
            <section className="alert-day" key={d.day}>
              <button
                type="button"
                className="alert-day-head"
                aria-expanded={expandedDay}
                aria-controls={`day-${d.day}`}
                onClick={() =>
                  setDayOpen({ ...dayOpen, [d.day]: !expandedDay })
                }
              >
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
                <strong>{d.label}</strong>
                <span>
                  {d.count} {d.count === 1 ? "alert" : "alerts"}
                </span>
              </button>
              {expandedDay && (
                <div id={`day-${d.day}`}>
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
                          const up = alertDirection(a) === "up";
                          const end = Date.parse(a.end);
                          const isNew = since !== null && end > since;
                          const tag =
                            sort === "ratio" ? sessionTag[a.session] : "";
                          return (
                            <li key={key} id={`alert-${key}`}>
                              <button
                                type="button"
                                className={
                                  expanded ? "alert-row open" : "alert-row"
                                }
                                aria-expanded={expanded}
                                onClick={() => setOpen(expanded ? null : key)}
                              >
                                <span className="alert-time">
                                  {israelClock(end)}
                                </span>
                                <span className="alert-symbol">
                                  <strong>{a.ticker}</strong>
                                  {isNew && (
                                    <span className="tag new">New</span>
                                  )}
                                  {tag && <span className="tag">{tag}</span>}
                                </span>
                                <span
                                  className={
                                    up ? "move-tag up" : "move-tag down"
                                  }
                                >
                                  {up ? "▲" : "▼"} {signedPct(a.move)}
                                </span>
                                <span className="alert-ratio">
                                  <strong>
                                    {a.ratio === null
                                      ? "—"
                                      : `${a.ratio.toFixed(1)}×`}
                                  </strong>
                                  <span className="meter" aria-hidden="true">
                                    <span
                                      style={{
                                        width: `${Math.min(100, ((a.ratio ?? 0) / ratioScale) * 100)}%`,
                                      }}
                                    />
                                  </span>
                                </span>
                                <VsSpyTag vsSpy={a.vsSpy} />
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
                              </button>
                              {expanded && (
                                <div className="alert-detail">
                                  <VsSpyLine
                                    vsSpy={a.vsSpy}
                                    now={nowForAlert(
                                      a.end,
                                      strengthNow[a.ticker],
                                    )}
                                  />
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
                                    />
                                  </Suspense>
                                  <div className="actions">
                                    {symbol !== a.ticker && (
                                      <button
                                        type="button"
                                        className="action"
                                        onClick={() => onSymbol(a.ticker)}
                                      >
                                        Only {a.ticker} alerts
                                      </button>
                                    )}
                                    <CopyLink alert={a} />
                                  </div>
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
        Times in {israelLabel}. Volume vs expected: the alert&apos;s volume
        ratio (window volume ÷ expected volume); the bar is full at {ratioScale}
        ×. vs SPY at alert: 0–100 score at the alert ({scoreNote});
        green ≥ {scoreStrong}, red ≤ {scoreWeak}, grey between; “—” without a
        score. It describes the move, it is not a trade recommendation. Expanded
        rows add today&apos;s current score (updated every 30 s) with ↑/↓ when
        it moved 5 or more points.
      </p>
    </>
  );
}
