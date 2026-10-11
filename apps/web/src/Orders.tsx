import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { OrderDecisions } from "../../../packages/trading/src/decisions-api.js";
import type {
  Decision,
  DecisionOutcome,
} from "../../../packages/trading/src/explain.js";
import { usePolling } from "./Live.js";
import { israelDateTime, israelLabel } from "./time.js";

// The reasons change only when a buy is sent or finishes.
export const ordersRefreshMs = 10000;

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const contractName = (d: Decision) => {
  const c = d.explanation.contract;
  const [, m, day] = c.expiry.split("-");
  return `${c.underlying} ${c.strike} ${c.right === "call" ? "Call" : "Put"} ${Number(m)}/${Number(day)}`;
};
const outcomes: Record<DecisionOutcome, [string, string]> = {
  refused: ["Refused", "red"],
  working: ["Working", "amber"],
  filled: ["Filled", "green"],
  "partly filled": ["Partly filled", "amber"],
  "not filled": ["Not filled", "grey"],
  failed: ["Failed", "red"],
};

function summary(d: Decision) {
  const e = d.explanation;
  if (d.outcome === "refused") return e.refused[0] ?? "A check failed";
  const r = d.result;
  if (!r)
    return e.offHours
      ? `${e.sizing.qty} ordered off hours, waiting for the open`
      : `${e.sizing.qty} ordered`;
  if (r.filledQty === 0) return `${e.sizing.qty} ordered, none filled`;
  return `${r.filledQty} of ${e.sizing.qty} at ${r.avgPrice?.toFixed(2) ?? "—"}${
    r.stopPrice === undefined ? "" : ` · stop ${r.stopPrice.toFixed(2)}`
  }`;
}

/** Why one order looks the way it does, in a window over the page. */
export function WhyDialog({
  decision,
  onClose,
}: {
  decision: Decision;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const e = decision.explanation;
  const [label, tone] = outcomes[decision.outcome];
  const failed = e.checks.filter((c) => !c.ok);
  // Rendered at the end of the page, outside the list row that opened it.
  return createPortal(
    <dialog
      ref={ref}
      className="why"
      aria-labelledby="why-title"
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === ref.current) ref.current?.close();
      }}
    >
      <div className="why-body">
        <header className="why-head">
          <div>
            <h2 id="why-title">{contractName(decision)}</h2>
            <p className="muted">
              {israelDateTime(decision.at)} {israelLabel}
              {e.paper ? " · paper account" : ""}
              {e.offHours ? " · sent off hours" : ""}
            </p>
          </div>
          <span className={`pill ${tone}`}>{label}</span>
          <button
            type="button"
            className="why-close"
            aria-label="Close"
            onClick={() => ref.current?.close()}
          >
            ×
          </button>
        </header>

        {e.refused.length > 0 && (
          <div className="why-refused" role="status">
            <strong>Nothing was sent.</strong>
            <ul>
              {e.refused.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        {e.notes.length > 0 && (
          <ul className="note-amber why-notes">
            {e.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}

        <section>
          <h3>What the order was built from</h3>
          <table className="why-table">
            <tbody>
              {e.inputs.map((i) => (
                <tr key={i.name}>
                  <th scope="row">{i.name}</th>
                  <td>{i.value}</td>
                  <td>
                    <span className={`why-source ${i.source}`}>
                      {i.source === "command" ? "from your command" : "default"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {e.selection && (
          <section>
            <h3>Contract</h3>
            <p>
              {e.selection.expiryRule} Offered:{" "}
              {e.selection.offered
                .map((o) => `${o.expiry} (${o.label})`)
                .join(", ")}
              .
            </p>
            <p>{e.selection.strikeRule}</p>
            {e.selection.strikes.length > 0 && (
              <table className="why-table why-strikes">
                <thead>
                  <tr>
                    <th scope="col">Strike</th>
                    <th scope="col">Delta</th>
                    <th scope="col">Bid</th>
                    <th scope="col">Ask</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {e.selection.strikes.map((s) => (
                    <tr key={s.strike} className={s.chosen ? "chosen" : ""}>
                      <td className="num">{s.strike}</td>
                      <td className="num">
                        {s.delta === null ? "—" : Math.abs(s.delta).toFixed(3)}
                      </td>
                      <td className="num">{s.bid.toFixed(2)}</td>
                      <td className="num">{s.ask.toFixed(2)}</td>
                      <td>{s.chosen ? "chosen" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        <section>
          <h3>Price</h3>
          <p>
            Bid {e.pricing.bid.toFixed(2)}, ask {e.pricing.ask.toFixed(2)}, mid{" "}
            {e.pricing.mid.toFixed(3)}; the spread is {e.pricing.spreadPct}% of
            the mid. {e.pricing.rule}
          </p>
        </section>
        <section>
          <h3>Size</h3>
          <p>{e.sizing.rule}</p>
        </section>
        <section>
          <h3>Stop</h3>
          <p>{e.stop.rule}</p>
        </section>
        <section>
          <h3>Risk manager</h3>
          <p>
            The account is in the <strong>{e.risk.state}</strong> state (
            {e.risk.reason}). With {e.risk.daysToExpiry} day
            {e.risk.daysToExpiry === 1 ? "" : "s"} to expiry, {e.risk.sharePct}%
            of the premium counts as at risk: {usd(e.risk.tradeRisk)} of{" "}
            {usd(e.risk.tradeLimit)} allowed per trade, and{" "}
            {usd(e.risk.dayRisk)} of {usd(e.risk.dayLimit)} allowed for the day.
          </p>
        </section>

        <section>
          <h3>
            Checks{" "}
            <span className="muted">
              {failed.length === 0
                ? `all ${e.checks.length} passed`
                : `${failed.length} of ${e.checks.length} failed`}
            </span>
          </h3>
          <ul className="why-checks">
            {e.checks.map((c) => (
              <li key={c.check} className={c.ok ? "ok" : "bad"}>
                <span aria-hidden="true">{c.ok ? "✓" : "✗"}</span>
                <span className="visually-hidden">
                  {c.ok ? "Passed:" : "Failed:"}
                </span>
                <strong>{c.check}</strong>
                <span className="muted">{c.detail}</span>
              </li>
            ))}
          </ul>
        </section>

        {decision.result && (
          <section>
            <h3>Result</h3>
            <p>
              {decision.result.filledQty} of {e.sizing.qty} filled
              {decision.result.avgPrice === null
                ? ""
                : ` at ${decision.result.avgPrice.toFixed(2)}`}
              {decision.result.stopPrice === undefined
                ? ""
                : `; stop at ${decision.result.stopPrice.toFixed(2)} on ${decision.result.stopQty}`}
              {decision.result.canceledQty
                ? `; ${decision.result.canceledQty} canceled unfilled`
                : ""}
              .{decision.result.error ? ` ${decision.result.error}` : ""}
            </p>
          </section>
        )}
      </div>
    </dialog>,
    document.body,
  );
}

/** A small button that opens the reasons behind one order. */
export function WhyButton({ decision }: { decision: Decision }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="why-button"
        onClick={() => setOpen(true)}
        aria-label={`Why this order: ${contractName(decision)}`}
      >
        Why
      </button>
      {open && <WhyDialog decision={decision} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The latest decision for each contract, to explain a position or an order. */
export function useDecisions(onError: (m: string) => void) {
  const { value } = usePolling<OrderDecisions>(
    "/api/portfolio/orders",
    ordersRefreshMs,
    onError,
  );
  const latest = new Map<string, Decision>();
  for (const d of value?.decisions ?? [])
    if (d.outcome !== "refused" && !latest.has(d.symbol))
      latest.set(d.symbol, d);
  return latest;
}

/** Every recent buy command, sent or refused, with its reasons. */
export function Orders({ onError }: { onError: (m: string) => void }) {
  const { value, error } = usePolling<OrderDecisions>(
    "/api/portfolio/orders",
    ordersRefreshMs,
    onError,
  );
  if (!value)
    return (
      <p className={error ? "notice error" : "chart-status"}>
        {error ? `Orders unavailable: ${error}` : "Loading orders…"}
      </p>
    );
  return (
    <div className="portfolio">
      <h2 className="portfolio-title">Buy orders and why</h2>
      <p className="muted">
        Every buy command, including refused ones: what came from the command,
        what was a default, how the contract, price and size were chosen, and
        each check.
      </p>
      {value.decisions.length > 0 ? (
        <ul className="portfolio-orders decisions">
          {value.decisions.map((d) => {
            const [label, tone] = outcomes[d.outcome];
            return (
              <li key={d.id}>
                <strong>{contractName(d)}</strong>
                <span className={`pill ${tone}`}>{label}</span>
                <WhyButton decision={d} />
                <span className="num">{summary(d)}</span>
                <span className="muted">
                  {israelDateTime(d.at)} {israelLabel}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="notice">No buy orders yet.</p>
      )}
    </div>
  );
}
