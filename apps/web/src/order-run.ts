import { readJson } from "./api.js";

// Sending an order from the page and following it to its end. Shared by the
// position controls and the trade ticket.

export type Job = {
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
    // A stock order (Trade → Shares).
    side?: "buy" | "sell";
    qty?: number;
    filledQty?: number;
    avgPrice?: number | null;
    working?: boolean;
    canceledQty?: number;
    shortRisks?: string[];
  } | null;
};
export type Started = { status: "started"; jobId: string };
export type Refused = { status: "refused"; refused: string[]; hint?: string };

export type Run =
  | { step: "idle" }
  | { step: "confirm" }
  | { step: "sending" }
  | { step: "working"; jobId: string; stage: string }
  | { step: "ended"; ok: boolean; lines: string[] };

/** What a finished order did, in the page's words. */
export function outcome(
  job: Job,
  buying: boolean,
): { ok: boolean; lines: string[] } {
  const r = job.result ?? {};
  const short = r.shortRisks?.length
    ? [`Short position risk: ${r.shortRisks.join("; ")}`]
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
  if (r.side) {
    const did = r.side === "buy" ? "Bought" : "Sold";
    const got = r.filledQty ?? 0;
    const left = (r.qty ?? 0) - got;
    return {
      ok: got > 0 || r.working === true,
      lines: [
        got > 0
          ? `${did} ${got} at ${r.avgPrice?.toFixed(2) ?? "—"}.`
          : `Nothing filled yet.`,
        ...(left > 0 && r.working
          ? [`${left} still working as a limit order for the day.`]
          : left > 0
            ? [`${left} did not fill.`]
            : []),
        ...short,
      ],
    };
  }
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

/**
 * Sends one order to an owner-only route and reports each step through
 * `setRun` until the order has ended. `alive` stops it when the page that
 * asked is gone.
 */
export async function followOrder(
  path: string,
  body: unknown,
  buying: boolean,
  setRun: (run: Run) => void,
  alive: { current: boolean },
): Promise<void> {
  setRun({ step: "sending" });
  try {
    const started = await readJson<Started | Refused>(
      await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
      const job = await fetch(`/api/portfolio/control/jobs/${started.jobId}`, {
        signal: AbortSignal.timeout(15000),
      })
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
