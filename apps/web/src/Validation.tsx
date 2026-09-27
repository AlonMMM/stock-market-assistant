import type { ValidationSummary } from "../../../packages/market-data/src/outcome.js";

const pct = (n: number, d: number) =>
  d ? `${Math.round((n / d) * 100)}%` : "—";
const signed = (n: number | null) =>
  n === null ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;

// Outcome of the alerts vs plain momentum entries (the baseline).
export function ValidationCard({ summary: s }: { summary: ValidationSummary }) {
  const b = s.baseline;
  const c = s.config;
  return (
    <section className="validation" aria-label="Alert validation">
      <h3>
        Did the momentum follow?{" "}
        <small>
          entry next minute · stop {c.stopUnits}u against · good {c.goodUnits}u
          in favour · {c.horizon} min · u = typical {c.unitMinutes}-min move at
          that time
        </small>
      </h3>
      <div className="validation-grid">
        <div className="vstat good">
          <strong>{pct(s.good, s.scored)}</strong>
          <span>✅ good momentum</span>
          <small>baseline {pct(b.good, b.scored)}</small>
        </div>
        <div className="vstat stopped">
          <strong>{pct(s.stopped, s.scored)}</strong>
          <span>❌ stopped</span>
          <small>baseline {pct(b.stopped, b.scored)}</small>
        </div>
        <div className="vstat">
          <strong>{pct(s.weak, s.scored)}</strong>
          <span>⏸ weak</span>
          <small>baseline {pct(b.weak, b.scored)}</small>
        </div>
        <div className="vstat">
          <strong>
            {s.medianRunUnits === null
              ? "—"
              : `${s.medianRunUnits.toFixed(1)}u`}
          </strong>
          <span>median best run</span>
          <small>
            {s.medianMinutesToGood === null
              ? ""
              : `good in ${Math.round(s.medianMinutesToGood)} min (median)`}
          </small>
        </div>
      </div>
      <p className="validation-forward">
        Median move in the alert&apos;s direction: 5 min{" "}
        {signed(s.medianForward[5])} · 15 min {signed(s.medianForward[15])} · 30
        min {signed(s.medianForward[30])} · 60 min {signed(s.medianForward[60])}
      </p>
      <p className="validation-meta">
        {s.scored} scored alerts
        {s.unscored > 0 &&
          ` · ${s.unscored} not scored (outside regular hours or no history)`}{" "}
        · baseline: {b.scored} momentum entries at every 5th minute
      </p>
      {s.scored < 50 && (
        <p className="notice">
          Only {s.scored} scored alerts — too few to judge. Use more symbols or
          a longer range.
        </p>
      )}
    </section>
  );
}
