import {
  bigScore,
  lookNowWeights,
  veryBigScore,
  type LookNow,
  type LookNowSummary,
} from "../../../packages/market-data/src/look-now.js";

const horizonName = (h: number | "close") =>
  h === "close" ? "close" : `${h}m`;
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
const pct = (n: number, d: number) =>
  d ? `${Math.round((n / d) * 100)}%` : "—";

export const lookNowLabelName = {
  "very-big": "Very big",
  big: "Big",
  normal: "Normal",
} as const;

/** Score badge for an alert row. */
export function LookNowBadge({ look }: { look: LookNow }) {
  if (look.score === null)
    return (
      <span className="look-badge none" title={look.reason}>
        ·
      </span>
    );
  return (
    <span
      className={`look-badge ${look.label}`}
      title={`Look-now score ${Math.round(look.score)} · ${lookNowLabelName[look.label!]}`}
    >
      {look.label === "very-big" ? "🔥" : ""}
      {Math.round(look.score)}
    </span>
  );
}

/** Per-alert detail line. */
export function LookNowLine({ look }: { look: LookNow }) {
  if (look.score === null)
    return (
      <p className="evidence">Look-now score: not scored — {look.reason}.</p>
    );
  return (
    <p className="evidence look-line">
      <strong>
        {look.label === "very-big" ? "🔥 " : ""}
        {Math.round(look.score)} · {lookNowLabelName[look.label!]}
      </strong>
      {look.peak !== null && <> · peak at {horizonName(look.peak)}</>}
      {look.withBurst !== null && (
        <> · {look.withBurst ? "with" : "against"} the burst</>
      )}
      {look.nearClose && " · near the close"}
      <br />
      {look.horizons.map((h, i) => (
        <span key={String(h.horizon)}>
          {i > 0 && " · "}
          {horizonName(h.horizon)} {signed(h.move)} (z {h.z.toFixed(1)}
          {h.percentile !== null && `, ${Math.round(h.percentile)}th`})
          {!h.marketAdjusted && "*"}
        </span>
      ))}
      {look.horizons.some((h) => !h.marketAdjusted) && (
        <> · * not market-adjusted</>
      )}
      {look.betaAssumed && " · β assumed 1"}
    </p>
  );
}

/** Backtest summary: alerts vs random minutes of the same stocks and days. */
export function LookNowCard({ summary: s }: { summary: LookNowSummary }) {
  const b = s.baseline;
  const lift = (n: number, bn: number) =>
    s.scored && b.scored && bn
      ? `${(n / s.scored / (bn / b.scored)).toFixed(1)}×`
      : "—";
  const reasons = Object.entries(s.reasons);
  return (
    <section className="validation look-card" aria-label="Look-now score">
      <h3>
        How unusual was the move after the alert?{" "}
        <small>
          largest market-adjusted move vs the stock&apos;s normal move at
          5/15/30/60 min and the close, ranked against random minutes · weights{" "}
          {Object.values(lookNowWeights)
            .map((w) => `${Math.round(w * 100)}%`)
            .join("/")}
        </small>
      </h3>
      <div className="validation-grid">
        <div className="vstat">
          <strong>
            {s.averageScore === null ? "—" : Math.round(s.averageScore)}
          </strong>
          <span>average score</span>
          <small>
            random minutes{" "}
            {b.averageScore === null ? "—" : Math.round(b.averageScore)}
          </small>
        </div>
        <div className="vstat good">
          <strong>{pct(s.big, s.scored)}</strong>
          <span>Big (≥{bigScore})</span>
          <small>
            random {pct(b.big, b.scored)} · {lift(s.big, b.big)}
          </small>
        </div>
        <div className="vstat good">
          <strong>{pct(s.veryBig, s.scored)}</strong>
          <span>🔥 Very big (≥{veryBigScore})</span>
          <small>
            random {pct(b.veryBig, b.scored)} · {lift(s.veryBig, b.veryBig)}
          </small>
        </div>
        <div className="vstat">
          <strong>{pct(s.withBurst, s.scored)}</strong>
          <span>peak with the burst</span>
          <small>the rest went against it</small>
        </div>
      </div>
      <p className="validation-forward">
        Peak horizon:{" "}
        {(["5", "15", "30", "60", "close"] as const)
          .map(
            (h) =>
              `${h === "close" ? "close" : `${h}m`} ${pct(s.peaks[h] ?? 0, s.scored)}`,
          )
          .join(" · ")}
      </p>
      <p className="validation-meta">
        {s.scored} scored alerts
        {s.unscored > 0 &&
          ` · ${s.unscored} not scored (${reasons.map(([r, n]) => `${n} ${r.toLowerCase()}`).join(", ")})`}{" "}
        · baseline: {b.scored} random minutes (every 5th regular minute)
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
