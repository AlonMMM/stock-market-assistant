import { lazy, Suspense, useEffect, useState } from "react";
import { alertLink } from "../../../packages/contracts/src/alert-link.js";
import { AlertEvidence, type FeedAlert } from "./AlertFeed.js";
import {
  alertDate,
  alertDirection,
  directionCounts,
  filterAlerts,
  groupAlerts,
  symbolCounts,
  type AlertSort,
  type DirectionFilter,
} from "./live-model.js";
import { israelClock, israelDateTime, israelLabel } from "./time.js";

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
  today,
  since,
}: {
  alerts: FeedAlert[];
  benchmarks?: Record<string, string>;
  focus?: string; // ticker + end of a row to open and scroll to on mount
  symbol: string | null;
  onSymbol: (s: string | null) => void;
  today: string; // current US session date
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
  const groups = groupAlerts(
    filterAlerts(alerts, direction, symbol),
    sort,
    today,
  );

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
          <span className="right">
            vs SPY × <span className="greek">β</span>
          </span>
          <span />
        </div>
        {groups.map((g) => (
          <section key={g.key} aria-label={`${g.title} ${g.sub}`}>
            <h3 className="alert-group">
              {g.title}{" "}
              <span>
                {g.sub} · {g.rows.length}{" "}
                {g.rows.length === 1 ? "alert" : "alerts"}
              </span>
            </h3>
            <ul>
              {g.rows.map((a) => {
                const key = a.ticker + a.end;
                const expanded = open === key;
                const up = alertDirection(a) === "up";
                const end = Date.parse(a.end);
                const isNew = since !== null && end > since;
                const tag = sort === "ratio" ? sessionTag[a.session] : "";
                return (
                  <li key={key} id={`alert-${key}`}>
                    <button
                      type="button"
                      className={expanded ? "alert-row open" : "alert-row"}
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : key)}
                    >
                      <span className="alert-time">
                        {sort === "ratio" && alertDate(a) !== today
                          ? israelDateTime(end)
                          : israelClock(end)}
                      </span>
                      <span className="alert-symbol">
                        <strong>{a.ticker}</strong>
                        {isNew && <span className="tag new">New</span>}
                        {tag && <span className="tag">{tag}</span>}
                      </span>
                      <span className={up ? "move-tag up" : "move-tag down"}>
                        {up ? "▲" : "▼"} {signedPct(a.move)}
                      </span>
                      <span className="alert-ratio">
                        <strong>
                          {a.ratio === null ? "—" : `${a.ratio.toFixed(1)}×`}
                        </strong>
                        <span className="meter" aria-hidden="true">
                          <span
                            style={{
                              width: `${Math.min(100, ((a.ratio ?? 0) / ratioScale) * 100)}%`,
                            }}
                          />
                        </span>
                      </span>
                      <span
                        className={
                          a.context
                            ? `alert-excess ${a.context.excess >= 0 ? "up" : "down"}`
                            : "alert-excess"
                        }
                      >
                        {a.context ? (
                          signedPct(a.context.excess, 1)
                        ) : (
                          <span aria-label="vs SPY times beta not available">
                            —
                          </span>
                        )}
                      </span>
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
                        <AlertEvidence alert={a} />
                        <Suspense
                          fallback={
                            <p className="chart-status">Loading day chart…</p>
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
        {groups.length === 0 && (
          <p className="table-empty">No alerts match these filters.</p>
        )}
      </div>
      <p className="table-note">
        Times in {israelLabel}. Volume vs expected: the alert&apos;s volume
        ratio (window volume ÷ expected volume); the bar is full at {ratioScale}
        ×. “vs SPY × β” shows “—” until live alerts carry market context.
      </p>
    </>
  );
}
