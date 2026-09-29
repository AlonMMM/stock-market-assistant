import type { AgentOutcome } from "../../../packages/analysis/src/agents.js";
import type {
  BenchmarkScore,
  Relation,
} from "../../../packages/analysis/src/relative-strength.js";
import {
  chartTitles,
  regimeShiftThreshold,
  technicalFacts,
  type Zone,
} from "../../../packages/analysis/src/technical-facts.js";
import type { LiveAnalysis } from "../../../packages/market-data/src/live.js";
import { israelClock, israelLabel } from "./time.js";

const relationName: Record<Relation, string> = {
  against: "Against the index",
  independent: "Independent (index flat)",
  with: "With the index",
  outperform: "Outperforms the index",
};

const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
const pts = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)} pts`;

function chartUrl(ticker: string, end: string, name: string) {
  return `/api/live/chart?${new URLSearchParams({ ticker, end, name })}`;
}

function Unavailable({ outcome }: { outcome: AgentOutcome<unknown> }) {
  return outcome.ok ? null : (
    <p className="analysis-muted">Unavailable: {outcome.error}</p>
  );
}

function ScoreCard({
  s,
  ticker,
  direction,
}: {
  s: BenchmarkScore;
  ticker: string;
  direction: "up" | "down" | null;
}) {
  if (!s.day || !s.relation)
    return (
      <div className="score-card">
        <strong>vs {s.benchmark}</strong>
        <p className="analysis-muted">Not enough data</p>
      </div>
    );
  const confirms =
    s.score === null || s.score === 50 || !direction
      ? null
      : s.score > 50 === (direction === "up");
  return (
    <div className="score-card">
      <div className="score-head">
        <strong>vs {s.benchmark}</strong>
        <span className={`relation relation-${s.relation}`}>
          {relationName[s.relation]}
        </span>
      </div>
      {s.score !== null && (
        <div className="score-meter" aria-label={`Score ${s.score} of 100`}>
          <span className="score-value">{s.score}</span>
          <span className="score-track" aria-hidden="true">
            <span className="score-mid" />
            <span className="score-dot" style={{ left: `${s.score}%` }} />
          </span>
          <span className="analysis-muted">
            {s.score > 50 ? "stronger" : s.score < 50 ? "weaker" : "in line"}
            {confirms !== null &&
              (confirms ? " · confirms the alert" : " · against the alert")}
          </span>
        </div>
      )}
      <p className="evidence">
        Today {ticker} {pct(s.day.stock)} vs {s.benchmark}{" "}
        {pct(s.day.benchmark)} · excess {pts(s.day.excess)} · β{" "}
        {s.beta.toFixed(2)}
        {s.betaAssumed && " (assumed)"}
        {s.window && (
          <>
            <br />
            Alert window {ticker} {pct(s.window.stock)} vs {s.benchmark}{" "}
            {pct(s.window.benchmark)}
          </>
        )}
      </p>
    </div>
  );
}

function Ladder({ title, zones }: { title: string; zones: Zone[] }) {
  if (!zones.length) return null;
  return (
    <div>
      <strong className="analysis-label">{title}</strong>
      <table className="ladder">
        <tbody>
          {zones.slice(0, 5).map((z) => (
            <tr key={z.level}>
              <td>{z.level}</td>
              <td>{pct(z.distancePct)}</td>
              <td>{z.labels.join(" / ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AnalysisPanel({
  ticker,
  end,
  direction,
  analysis,
}: {
  ticker: string;
  end: string;
  direction: "up" | "down" | null;
  analysis: LiveAnalysis;
}) {
  const r = analysis.result;
  if (!r)
    return (
      <section className="analysis">
        <h3>Analysis</h3>
        <p className="analysis-muted">
          {analysis.status === "pending" || analysis.status === "running"
            ? "Analyzing… usually under a minute."
            : analysis.status === "expired"
              ? "Not analyzed: the request was too old when its turn came."
              : `Analysis failed${analysis.error ? `: ${analysis.error}` : "."}`}
        </p>
      </section>
    );
  // Analyses stored before charts were kept have no `charts`.
  const charts = r.charts ?? [];
  const t = r.technical;
  const f = r.technicalSummary ? technicalFacts(r.technicalSummary) : null;
  const s = r.sentiment;
  const n = r.news;
  const item = n.ok ? n.value.item : null;
  const itemAge = item
    ? Math.floor((Date.parse(end) - Date.parse(item.createdAt)) / 60000)
    : null;
  const newsUrl = n.ok ? (item?.url ?? n.value.url) : null;
  return (
    <section className="analysis">
      <h3>
        Analysis{" "}
        <small>
          {israelClock(Date.parse(r.completedAt))} {israelLabel} · AI analysis,
          not investment advice
        </small>
      </h3>

      <h4>Relative strength</h4>
      {r.scores.length ? (
        <div className="score-grid">
          {r.scores.map((sc) => (
            <ScoreCard
              key={sc.benchmark}
              s={sc}
              ticker={ticker}
              direction={direction}
            />
          ))}
        </div>
      ) : (
        <p className="analysis-muted">No benchmark.</p>
      )}

      <h4>
        Technical{" "}
        {t.ok && (
          <span className={`lean lean-${t.value.lean}`}>{t.value.lean}</span>
        )}
      </h4>
      {t.ok ? (
        <div className="analysis-text">
          <p>
            <strong>Now:</strong> {t.value.immediate}
          </p>
          <p>
            <strong>Follow-through:</strong> {t.value.followThrough}
          </p>
          {t.value.drivers.length > 0 && (
            <ul>
              {t.value.drivers.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
          {t.value.caveat && <p className="analysis-muted">{t.value.caveat}</p>}
        </div>
      ) : (
        <Unavailable outcome={t} />
      )}
      {f && (
        <>
          <dl className="facts">
            {f.spot !== null && (
              <>
                <dt>Spot</dt>
                <dd>
                  {f.spot}
                  {f.vwap !== null &&
                    ` · VWAP ${f.vwap} (${f.spot >= f.vwap ? "above" : "below"})`}
                </dd>
              </>
            )}
            {f.pivots && (
              <>
                <dt>Pivots</dt>
                <dd>
                  PP {f.pivots.pp} · R1 {f.pivots.r1} · R2 {f.pivots.r2} · R3{" "}
                  {f.pivots.r3} · S1 {f.pivots.s1} · S2 {f.pivots.s2} · S3{" "}
                  {f.pivots.s3}
                </dd>
              </>
            )}
            {f.volumeProfile && (
              <>
                <dt>Volume profile</dt>
                <dd>
                  POC {f.volumeProfile.poc} · VAH {f.volumeProfile.vah} · VAL{" "}
                  {f.volumeProfile.val}
                </dd>
              </>
            )}
            {f.priorWeek && (
              <>
                <dt>Prior week</dt>
                <dd>
                  {f.priorWeek.low}–{f.priorWeek.high}
                </dd>
              </>
            )}
            {f.swings.length > 0 && (
              <>
                <dt>Swing levels</dt>
                <dd>
                  {f.swings
                    .map((w) => `${w.level} (${w.strength}×)`)
                    .join(" · ")}
                </dd>
              </>
            )}
            {f.benchmark && f.beta60 !== null && (
              <>
                <dt>β vs {f.benchmark}</dt>
                <dd>
                  60d {f.beta60}
                  {f.correlation60 !== null && ` (corr ${f.correlation60})`}
                  {f.beta20 !== null && ` · 20d ${f.beta20}`}
                  {f.regimeShift !== null &&
                    Math.abs(f.regimeShift) > regimeShiftThreshold && (
                      <strong> · beta regime shift</strong>
                    )}
                </dd>
              </>
            )}
            {f.alphaNowPp !== null && (
              <>
                <dt>Alpha now</dt>
                <dd>
                  {pts(f.alphaNowPp)}
                  {f.alphaPositivePct !== null &&
                    ` · positive ${f.alphaPositivePct}% of the session`}
                </dd>
              </>
            )}
            {f.quadrant && (
              <>
                <dt>RS rotation</dt>
                <dd>
                  <strong>{f.quadrant}</strong>
                  {f.rsRatio !== null &&
                    f.rsMomentum !== null &&
                    ` · ratio ${f.rsRatio}, momentum ${f.rsMomentum}`}
                  {f.rsNewHigh && " · RS line at a new high"}
                </dd>
              </>
            )}
            {f.divergences.length > 0 && (
              <>
                <dt>Vs the tape</dt>
                <dd>
                  {f.divergences.map((d) => (
                    <span key={d.start} className="divergence">
                      {d.kind === "against" ? "Moved against" : "Held through"}{" "}
                      {israelClock(Date.parse(d.start))}–
                      {israelClock(Date.parse(d.end))}: stock {pts(d.stockPp)},
                      benchmark {pts(d.benchmarkPp)}
                    </span>
                  ))}
                </dd>
              </>
            )}
          </dl>
          <div className="ladders">
            <Ladder title="Resistance above" zones={f.resistance} />
            <Ladder title="Support below" zones={f.support} />
          </div>
          <p className="analysis-muted">
            From the technical-scan skill. Options open interest is not
            included; the RS quadrant is an open reconstruction, not the
            licensed RRG. Volume is IEX-only.
          </p>
        </>
      )}
      {charts.length > 0 && (
        <div className="chart-gallery">
          {charts.map((name) => (
            <figure key={name}>
              <a
                href={chartUrl(ticker, end, name)}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  src={chartUrl(ticker, end, name)}
                  alt={`${ticker} ${chartTitles[name] ?? name}`}
                  loading="lazy"
                />
              </a>
              <figcaption>{chartTitles[name] ?? name}</figcaption>
            </figure>
          ))}
        </div>
      )}

      <h4>
        Sentiment{" "}
        {s.ok && (
          <span className={`lean lean-${s.value.sentiment}`}>
            {s.value.sentiment} · {s.value.confidence} confidence
          </span>
        )}
      </h4>
      {s.ok ? (
        <div className="analysis-text">
          <p>{s.value.summary}</p>
          {s.value.drivers.length > 0 && (
            <ul>
              {s.value.drivers.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
          {s.value.sources.length > 0 && (
            <p className="analysis-sources">
              {s.value.sources.map((src) => (
                <a
                  key={src.url}
                  href={src.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {src.title}
                </a>
              ))}
            </p>
          )}
        </div>
      ) : (
        <Unavailable outcome={s} />
      )}

      <h4>
        News{" "}
        {n.ok && (
          <span className={`lean explains-${n.value.explains}`}>
            explains the move: {n.value.explains}
          </span>
        )}
      </h4>
      {n.ok ? (
        <div className="analysis-text">
          {n.value.catalyst && (
            <p>
              <strong>{n.value.catalyst}</strong>
            </p>
          )}
          <p>{n.value.summary}</p>
          {(item || newsUrl) && (
            <p className="analysis-sources">
              {item && (
                <span>
                  {item.source},{" "}
                  {itemAge! < 120
                    ? `${itemAge} min`
                    : `${Math.round(itemAge! / 60)} h`}{" "}
                  before the alert
                </span>
              )}
              {newsUrl && (
                <a href={newsUrl} target="_blank" rel="noreferrer">
                  {item?.headline ?? "Source"}
                </a>
              )}
            </p>
          )}
        </div>
      ) : (
        <Unavailable outcome={n} />
      )}
    </section>
  );
}
