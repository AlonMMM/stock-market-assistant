import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ControlAccess } from "../../../packages/trading/src/control-api.js";
import type { Decision } from "../../../packages/trading/src/explain.js";
import type { PortfolioPosition } from "../../../packages/trading/src/portfolio.js";
import { readJson } from "./api.js";
import { WhyButton } from "./Orders.js";
import { chartSession } from "./positions-model.js";

// Open positions as a dense list, in the manner of a broker's phone app: one
// row per position, and a tap opens the stock's day chart, the position's
// numbers and, for the account owner, the controls.

const DayChart = lazy(() =>
  import("./DayChart.js").then((m) => ({ default: m.DayChart })),
);

const usd = (n: number, digits = 0) =>
  `$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
const signedUsd = (n: number) => `${n >= 0 ? "+" : "−"}${usd(n)}`;
const signedPct = (n: number) =>
  `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`;
const tone = (n: number | null) =>
  n === null || n === 0 ? "" : n > 0 ? " up" : " down";
const expiry = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
});
const expiryLabel = (date: string) =>
  expiry.format(Date.parse(`${date}T00:00:00Z`));
const plural = (n: number, unit: string) =>
  `${n} ${unit}${Math.abs(n) === 1 ? "" : "s"}`;

/** Whether this visitor may change positions; asked once per page. */
export function useControlAccess(): ControlAccess {
  const [access, setAccess] = useState<ControlAccess>({ canTrade: false });
  useEffect(() => {
    let live = true;
    fetch("/api/portfolio/control", { signal: AbortSignal.timeout(15000) })
      .then((r) => readJson<ControlAccess>(r))
      .then(
        (a) => live && setAccess(a),
        () => {}, // without an answer there are no controls
      );
    return () => {
      live = false;
    };
  }, []);
  return access;
}

type Job = {
  state: "running" | "done" | "failed" | "interrupted";
  stage?: string;
  result?: {
    error?: string;
    notes?: string[];
    // A sale.
    result?: {
      sold?: number;
      price?: number | null;
      remaining?: number;
      // A buy.
      order?: { filledQty: number; filledAvgPrice: number | null } | null;
    };
    stop?: { price?: number; qty?: number; error?: string };
    canceledQty?: number;
    shortRisks?: string[];
  } | null;
};
type Started = { status: "started"; jobId: string };
type Refused = { status: "refused"; refused: string[]; hint?: string };

type Run =
  | { step: "idle" }
  | { step: "confirm" }
  | { step: "sending" }
  | { step: "working"; jobId: string; stage: string }
  | { step: "ended"; ok: boolean; lines: string[] };

/** What a finished order did, in the page's words. */
function outcome(job: Job, buying: boolean): { ok: boolean; lines: string[] } {
  const r = job.result ?? {};
  const short = r.shortRisks?.length
    ? [`Short option risk: ${r.shortRisks.join("; ")}`]
    : [];
  if (job.state !== "done")
    return {
      ok: false,
      lines: [
        job.state === "interrupted"
          ? `The trading service restarted during the order. ${(r.notes ?? []).join("; ")}`
          : `The order failed: ${r.error ?? "no reason given"}`,
        ...short,
      ],
    };
  if (buying) {
    const got = r.result?.order?.filledQty ?? 0;
    const at = r.result?.order?.filledAvgPrice;
    return {
      ok: got > 0,
      lines: [
        got > 0
          ? `Bought ${got} at ${at?.toFixed(2) ?? "—"}.`
          : "Nothing filled; the order was withdrawn.",
        ...(got > 0 && r.canceledQty
          ? [`${r.canceledQty} did not fill and were withdrawn.`]
          : []),
        ...(got > 0
          ? [
              r.stop?.price !== undefined
                ? `Stop at ${r.stop.price.toFixed(2)} on ${r.stop.qty}.`
                : `No stop was placed: ${r.stop?.error ?? "unknown reason"}.`,
            ]
          : []),
        ...short,
      ],
    };
  }
  const sold = r.result?.sold ?? 0;
  return {
    ok: sold > 0,
    lines: [
      sold > 0
        ? `Sold ${sold} at ${r.result?.price?.toFixed(2) ?? "—"}${r.result?.remaining ? `, ${r.result.remaining} still held` : ""}.`
        : "Nothing sold at the bid in time; the stop is back in place.",
      ...short,
    ],
  };
}

/** Add to, reduce or close one position. Shown to the account owner only. */
function Controls({ p }: { p: PortfolioPosition }) {
  const [target, setTarget] = useState(p.qty);
  const [run, setRun] = useState<Run>({ step: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const busy = run.step === "sending" || run.step === "working";
  // After a fill the position has a new size: start again from it.
  useEffect(() => {
    if (!busy) setTarget(p.qty);
  }, [p.qty]);
  const diff = target - p.qty;
  const buying = diff > 0;
  const action =
    diff === 0
      ? "No change"
      : target === 0
        ? "Close position"
        : buying
          ? `Buy ${diff} more`
          : `Sell ${-diff}`;
  const question =
    target === 0
      ? `Sell all ${p.qty} at the bid?`
      : buying
        ? `Buy ${diff} more, for about ${p.price === null ? "—" : usd(diff * p.price * 100)}?`
        : `Sell ${-diff} of ${p.qty} at the bid?`;
  const set = (qty: number) => {
    setTarget(Math.max(0, Math.round(qty)));
    setRun({ step: "idle" });
  };

  async function send() {
    setRun({ step: "sending" });
    try {
      const started = await readJson<Started | Refused>(
        await fetch("/api/portfolio/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contract: p.symbol, qty: target }),
          signal: AbortSignal.timeout(30000),
        }),
      );
      if (!alive.current) return;
      if (started.status === "refused")
        return setRun({
          step: "ended",
          ok: false,
          lines: [
            "Refused, nothing was sent:",
            ...started.refused,
            ...(started.hint ? [started.hint] : []),
          ],
        });
      setRun({
        step: "working",
        jobId: started.jobId,
        stage: "sending the order",
      });
      // A buy raises its price and watches the fill for up to about 3 minutes.
      for (let i = 0; i < 150; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!alive.current) return;
        const job = await fetch(
          `/api/portfolio/control/jobs/${started.jobId}`,
          { signal: AbortSignal.timeout(15000) },
        )
          .then((r) => readJson<Job>(r))
          .catch(() => null); // one missed answer; the next one is asked for
        if (!alive.current) return;
        if (!job) continue;
        if (job.state === "running") {
          setRun({
            step: "working",
            jobId: started.jobId,
            stage: job.stage ?? "working",
          });
          continue;
        }
        return setRun({ step: "ended", ...outcome(job, buying) });
      }
      setRun({
        step: "ended",
        ok: false,
        lines: [
          "The order is still running. Its result will show in the position and in Orders.",
        ],
      });
    } catch (error) {
      if (!alive.current) return;
      setRun({
        step: "ended",
        ok: false,
        lines: [
          error instanceof Error ? error.message : "The request failed",
          "Check the position before trying again.",
        ],
      });
    }
  }

  return (
    <div className="pos-controls">
      <div className="pos-size">
        <span className="pos-size-label" id={`size-${p.symbol}`}>
          Contracts
        </span>
        <div
          className="stepper"
          role="group"
          aria-labelledby={`size-${p.symbol}`}
        >
          <button
            type="button"
            onClick={() => set(target - 1)}
            disabled={busy || target === 0}
            aria-label="One contract fewer"
          >
            −
          </button>
          <input
            className="num"
            inputMode="numeric"
            pattern="[0-9]*"
            aria-labelledby={`size-${p.symbol}`}
            value={target}
            disabled={busy}
            onChange={(e) => set(Number(e.target.value.replace(/\D/g, "")))}
          />
          <button
            type="button"
            onClick={() => set(target + 1)}
            disabled={busy}
            aria-label="One contract more"
          >
            +
          </button>
        </div>
        <div className="pos-quick">
          <button
            type="button"
            onClick={() => set(Math.floor(p.qty / 2))}
            disabled={busy || p.qty < 2}
          >
            Half
          </button>
          <button type="button" onClick={() => set(0)} disabled={busy}>
            Close
          </button>
        </div>
      </div>
      {run.step === "confirm" ? (
        <div
          className="pos-confirm"
          role="group"
          aria-label="Confirm the order"
        >
          <span>{question}</span>
          <button
            type="button"
            className={buying ? "pos-go" : "pos-go sell"}
            onClick={() => void send()}
          >
            Confirm
          </button>
          <button
            type="button"
            className="pos-cancel"
            onClick={() => setRun({ step: "idle" })}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={buying || diff === 0 ? "pos-go" : "pos-go sell"}
          disabled={busy || diff === 0}
          onClick={() => setRun({ step: "confirm" })}
        >
          {busy ? "Working…" : action}
        </button>
      )}
      <p className="pos-run" role="status">
        {run.step === "sending" && "Sending…"}
        {run.step === "working" && `In progress: ${run.stage}.`}
        {run.step === "ended" && (
          <span className={run.ok ? "" : "pos-problem"}>
            {run.lines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </span>
        )}
        {run.step === "idle" &&
          buying &&
          "An addition passes the same checks as any buy. One position may cost at most 5% of the account."}
        {run.step === "idle" &&
          diff < 0 &&
          "Sold at the bid; the stop stays on what is left."}
      </p>
    </div>
  );
}

function Detail({
  p,
  why,
  access,
}: {
  p: PortfolioPosition;
  why?: Decision | undefined;
  access: ControlAccess;
}) {
  // How far the current price is above the stop, as a share of the price.
  const away =
    p.stop && p.price ? ((p.price - p.stop.price) / p.price) * 100 : null;
  return (
    <div className="pos-detail">
      <dl className="pos-facts">
        <div>
          <dt>Entry</dt>
          <dd className="num">{p.entry.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd className="num">{usd(p.cost)}</dd>
        </div>
        <div>
          <dt>Of account</dt>
          <dd className="num">
            {p.sharePct === null ? "—" : `${p.sharePct.toFixed(1)}%`}
          </dd>
        </div>
        <div>
          <dt>Today</dt>
          <dd className={`num${tone(p.dayPnl)}`}>
            {p.dayPnl === null ? "—" : signedUsd(p.dayPnl)}
          </dd>
        </div>
      </dl>
      <p className={p.stop ? "pos-stop" : "pos-stop missing"}>
        <strong>Stop</strong>
        {p.stop ? (
          <span className="num">
            {p.stop.price.toFixed(2)}, {p.stop.lossPct.toFixed(0)}% below the
            entry: {usd(p.stop.risk)} at risk
            {away !== null &&
              (away > 0
                ? `. The price is ${away.toFixed(0)}% above it`
                : ". The price is at or below it")}
            .
            {p.stop.qty < p.qty && (
              <em>
                {" "}
                It covers {p.stop.qty} of {p.qty}.
              </em>
            )}
          </span>
        ) : (
          <span>No stop order is in place.</span>
        )}
      </p>
      {access.canTrade && p.option && p.qty > 0 ? (
        <Controls p={p} />
      ) : (
        access.reason && <p className="muted">{access.reason}.</p>
      )}
      <Suspense fallback={<p className="chart-status">Loading day chart…</p>}>
        <DayChart ticker={p.underlying} date={chartSession()} />
      </Suspense>
      {why && (
        <p className="pos-why">
          <WhyButton decision={why} />
          <span className="muted">How this order was chosen and sized</span>
        </p>
      )}
    </div>
  );
}

function Row({
  p,
  why,
  access,
  open,
  onToggle,
}: {
  p: PortfolioPosition;
  why?: Decision | undefined;
  access: ControlAccess;
  open: boolean;
  onToggle: () => void;
}) {
  const stopText = !p.stop
    ? "no stop"
    : p.stop.qty < p.qty
      ? `stop ${p.stop.price.toFixed(2)} (${p.stop.qty}/${p.qty})`
      : `stop ${p.stop.price.toFixed(2)}`;
  const bare = !p.stop || p.stop.qty < p.qty;
  return (
    <li className={open ? "pos open" : "pos"}>
      <button
        type="button"
        className="pos-row"
        aria-expanded={open}
        aria-controls={`pos-${p.symbol}`}
        onClick={onToggle}
      >
        <span className="pos-name">
          <strong>
            {p.underlying}
            {p.option && (
              <span className={`pos-side ${p.option.right}`}>
                {p.option.strike} {p.option.right === "call" ? "C" : "P"}
              </span>
            )}
          </strong>
          <span className="pos-sub">
            {p.option ? `${expiryLabel(p.option.expiry)} · ` : ""}
            <span aria-hidden="true">×{p.qty}</span>
            <span className="sr-only">
              {plural(p.qty, p.option ? "contract" : "share")}
            </span>
          </span>
        </span>
        <span className="pos-cell">
          <span className="sr-only">Last </span>
          <span className="num">
            {p.price === null ? "—" : p.price.toFixed(2)}
          </span>
          <span className={bare ? "pos-sub num warn" : "pos-sub num"}>
            {stopText}
          </span>
        </span>
        <span className="pos-cell">
          <span className="sr-only">Value </span>
          <span className="num">{p.value === null ? "—" : usd(p.value)}</span>
          <span className="pos-sub num">at {p.entry.toFixed(2)}</span>
        </span>
        <span className={`pos-cell pos-pnl${tone(p.pnl)}`}>
          <span className="sr-only">Profit and loss </span>
          <span className="num">{p.pnl === null ? "—" : signedUsd(p.pnl)}</span>
          <span className="pos-sub num">
            {p.pnlPct === null ? "—" : signedPct(p.pnlPct)}
          </span>
        </span>
      </button>
      {open && (
        <div id={`pos-${p.symbol}`}>
          <Detail p={p} why={why} access={access} />
        </div>
      )}
    </li>
  );
}

export function PositionList({
  positions,
  why,
}: {
  positions: PortfolioPosition[];
  why: Map<string, Decision>;
}) {
  const access = useControlAccess();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="pos-list">
      <div className="pos-head" aria-hidden="true">
        <span>Position</span>
        <span>Last, stop</span>
        <span>Value</span>
        <span>P&amp;L</span>
      </div>
      <ul>
        {positions.map((p) => (
          <Row
            key={p.symbol}
            p={p}
            why={why.get(p.symbol)}
            access={access}
            open={open === p.symbol}
            onToggle={() => setOpen(open === p.symbol ? null : p.symbol)}
          />
        ))}
      </ul>
    </div>
  );
}
