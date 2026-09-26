import type { Evaluation } from "../../../packages/alerts/src/relative-volume.js";

export const number = (n: number) => n.toLocaleString("en-US");

export function AlertCard({
  alert: a,
}: {
  alert: Evaluation & { close?: number };
}) {
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
        ·{" "}
        {new Date(a.end).toLocaleString("en-US", {
          timeZone: "America/New_York",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}{" "}
        ET
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
    </article>
  );
}
