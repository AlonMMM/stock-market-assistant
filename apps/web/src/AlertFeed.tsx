import type { Evaluation } from "../../../packages/alerts/src/relative-volume.js";
import type { AlertContext } from "../../../packages/market-data/src/backtest.js";
import type { LiveAnalysis } from "../../../packages/market-data/src/live.js";
import type { Outcome } from "../../../packages/market-data/src/outcome.js";
import { number } from "./api.js";
import {
  vsSpyCell,
  vsSpyDetail,
  type StrengthNow,
  type VsSpy,
} from "./vs-spy-model.js";

// Backtest alerts carry close and market context; live alerts may lack them.
export type FeedAlert = Evaluation & {
  close?: number;
  context?: AlertContext | null;
  outcome?: Outcome; // backtest only: what the price did after the alert
  analysis?: LiveAnalysis; // live only, when the collector analyzes alerts
  vsSpy?: VsSpy; // score vs SPY at alert time; absent from older data
};

const signed = (n: number) => (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(1);

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

/**
 * Row cell: the alert-time score coloured green ≥ 60 / red ≤ 40 / grey
 * between; "stronger / weaker / normal vs SPY" only in the accessible label
 * and tooltip. "—" without a score. Old alerts' labels are ignored.
 */
export function VsSpyTag({ vsSpy }: { vsSpy: VsSpy | null | undefined }) {
  const c = vsSpyCell(vsSpy);
  return (
    <span
      className={c.score === null ? "vs-spy none" : "vs-spy"}
      title={c.title}
    >
      <small className="vs-spy-prefix" aria-hidden="true">
        vs SPY
      </small>
      <strong className={`vs-spy-score ${c.tone}`} aria-hidden="true">
        {c.text}
      </strong>
      <span className="sr-only">{c.title}</span>
    </span>
  );
}

/** Expanded-row line: alert-time score, current score and trend, beta. */
export function VsSpyLine({
  vsSpy,
  now = null,
}: {
  vsSpy: VsSpy | null | undefined;
  now?: StrengthNow | null;
}) {
  return (
    <p className="evidence vs-spy-line">
      {vsSpyDetail(vsSpy, now)}
      {vsSpy?.spyLagged && (
        <small
          className="vs-spy-lagged"
          title="SPY's bar for the alert minute had not arrived; SPY's latest bar was used"
        >
          {" "}
          · SPY bar lagged
        </small>
      )}
    </p>
  );
}
