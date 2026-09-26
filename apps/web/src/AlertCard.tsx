import { lazy, Suspense, useState } from "react";
import type { Evaluation } from "../../../packages/alerts/src/relative-volume.js";
import { israelDateTime, israelLabel } from "./time.js";

// Loaded on first use so the chart library stays out of the initial bundle.
const DayChart = lazy(() =>
  import("./DayChart.js").then((m) => ({ default: m.DayChart })),
);

export const number = (n: number) => n.toLocaleString("en-US");

export function AlertCard({
  alert: a,
  chart = false,
}: {
  alert: Evaluation & { close?: number };
  chart?: boolean; // real market data is available for this alert
}) {
  const [open, setOpen] = useState(false);
  return (
    <article className="volume-alert">
      <h3 aria-label={a.ticker + " · " + a.ratio?.toFixed(1) + "× volume"}>
        {a.ticker}
      </h3>
      <p className="session">
        {a.session === "regular"
          ? "Regular session"
          : a.session === "pre"
            ? "Pre-market"
            : "After-hours"}{" "}
        · {israelDateTime(Date.parse(a.end))} {israelLabel}
      </p>
      <div className="metrics">
        <strong className="ratio">{a.ratio?.toFixed(1)}×</strong>
        <div className="metric">
          <strong>{number(a.actual)}</strong>
          <small>Actual shares</small>
        </div>
        <div className="metric">
          <strong>{number(a.expected ?? 0)}</strong>
          <small>Expected shares</small>
        </div>
      </div>
      <div aria-hidden="true">
        <div className="bar-row">
          <span>Actual ({number(a.actual)})</span>
          <div className="bar-track">
            <div className="bar" style={{ width: "100%" }} />
          </div>
        </div>
        <div className="bar-row">
          <span>Expected ({number(a.expected ?? 0)})</span>
          <div className="bar-track">
            <div
              className="bar expected"
              style={{
                width: ((a.expected ?? 0) / a.actual) * 100 + "%",
              }}
            />
          </div>
        </div>
      </div>
      <p className="reason">
        Volume crossed your {a.config.threshold.toFixed(1)}× threshold.
      </p>
      <p className="evidence">
        {a.close !== undefined && <>Close ${a.close.toFixed(2)} · </>}
        {a.samples} historical samples · Rule v1 · {a.config.cooldown} min
        cooldown
      </p>
      {chart && (
        <>
          <button
            type="button"
            className="chart-toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? "Hide chart" : "Show day chart with SPY"}
          </button>
          {open && (
            <Suspense
              fallback={<p className="chart-status">Loading day chart…</p>}
            >
              <DayChart
                ticker={a.ticker}
                alertEnd={a.end}
                window={a.config.window}
              />
            </Suspense>
          )}
        </>
      )}
    </article>
  );
}
