import { lazy, Suspense, useState } from "react";
import type { Evaluation } from "../../../packages/alerts/src/relative-volume.js";
import type { AlertContext } from "../../../packages/market-data/src/backtest.js";

// Backtest alerts carry close and market context; live alerts may lack them.
export type FeedAlert = Evaluation & {
  close?: number;
  context?: AlertContext | null;
};
import { number } from "./api.js";
import { israelDateTime, israelLabel } from "./time.js";

const DayChart = lazy(() =>
  import("./DayChart.js").then((m) => ({ default: m.DayChart })),
);

const signed = (n: number) => (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(1);
const sessionTag = { pre: "Pre", regular: "", post: "After" };

type Sort = "time" | "ratio";

export function AlertFeed({ alerts }: { alerts: FeedAlert[] }) {
  const [ticker, setTicker] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("time");
  const [open, setOpen] = useState<string | null>(null);

  const counts = new Map<string, number>();
  for (const a of alerts) counts.set(a.ticker, (counts.get(a.ticker) ?? 0) + 1);
  const tickers = [...counts].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  );
  const shown = alerts
    .filter((a) => !ticker || a.ticker === ticker)
    .sort((a, b) =>
      sort === "ratio"
        ? (b.ratio ?? 0) - (a.ratio ?? 0)
        : b.end.localeCompare(a.end),
    );

  return (
    <div className="feed">
      <div className="feed-filters">
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
          return (
            <li key={key} className={expanded ? "feed-row open" : "feed-row"}>
              <button
                type="button"
                className="feed-summary"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : key)}
              >
                <strong className="feed-ticker">{a.ticker}</strong>
                <span className="feed-time">
                  {israelDateTime(Date.parse(a.end))}
                  {sessionTag[a.session] && (
                    <em className="feed-session">{sessionTag[a.session]}</em>
                  )}
                </span>
                <strong className="feed-ratio">{a.ratio?.toFixed(1)}×</strong>
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
                  <p className="evidence">
                    {number(a.actual)} shares in {a.config.window} min vs{" "}
                    {number(a.expected ?? 0)} expected
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
                  <Suspense
                    fallback={
                      <p className="chart-status">Loading day chart…</p>
                    }
                  >
                    <DayChart
                      ticker={a.ticker}
                      alertEnd={a.end}
                      window={a.config.window}
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
