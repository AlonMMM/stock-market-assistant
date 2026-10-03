import type { Evaluation } from "../../../packages/alerts/src/relative-volume.js";
import type { AlertContext } from "../../../packages/market-data/src/backtest.js";
import type { LiveAnalysis } from "../../../packages/market-data/src/live.js";
import type { Outcome } from "../../../packages/market-data/src/outcome.js";
import { number } from "./api.js";

// Backtest alerts carry close and market context; live alerts may lack them.
export type FeedAlert = Evaluation & {
  close?: number;
  context?: AlertContext | null;
  outcome?: Outcome; // backtest only: what the price did after the alert
  analysis?: LiveAnalysis; // live only, when the collector analyzes alerts
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
