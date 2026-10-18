import { useEffect, useState } from "react";
import type {
  PriceAlert,
  PriceAlertKind,
} from "../../../packages/market-data/src/price-alerts.js";
import { readJson } from "./api.js";

// The user's own alerts on one stock (user 2026-10-18): a price above or
// below, or a % move today. The server checks them every minute and sends
// each one that is met to Telegram once.

const kinds: { kind: PriceAlertKind; label: string; unit: "$" | "%" }[] = [
  { kind: "above", label: "Price above", unit: "$" },
  { kind: "below", label: "Price below", unit: "$" },
  { kind: "up", label: "Up today by", unit: "%" },
  { kind: "down", label: "Down today by", unit: "%" },
];
const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "Price above 220.00", "Down today by 3%". */
export function alertRule(a: Pick<PriceAlert, "kind" | "value">): string {
  const k = kinds.find((x) => x.kind === a.kind)!;
  return k.unit === "$"
    ? `${k.label} ${a.value.toFixed(2)}`
    : `${k.label} ${a.value}%`;
}

async function send(method: string, path: string, body?: unknown) {
  return readJson<unknown>(
    await fetch(path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(15000),
    }),
  );
}

export function PriceAlerts({
  ticker,
  last,
}: {
  ticker: string;
  last: number | null;
}) {
  const [alerts, setAlerts] = useState<PriceAlert[] | null>(null);
  const [kind, setKind] = useState<PriceAlertKind>("above");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = () =>
    send("GET", `/api/price-alerts?ticker=${encodeURIComponent(ticker)}`)
      .then((b) => setAlerts((b as { alerts: PriceAlert[] }).alerts))
      .catch((e: unknown) => setMessage((e as Error).message));
  useEffect(() => {
    void load();
    // A fired alert shows as fired without a reload.
    const timer = setInterval(() => void load(), 60000);
    return () => clearInterval(timer);
  }, [ticker]);
  const unit = kinds.find((k) => k.kind === kind)!.unit;
  const n = Number(value);
  const valid = value.trim() !== "" && n > 0 && (unit === "$" || n < 100);
  // A level already passed fires at the next minute's check.
  const already =
    valid &&
    last !== null &&
    ((kind === "above" && last >= n) || (kind === "below" && last <= n));
  const run = (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage("");
    work()
      .then(() => {
        setMessage(done);
        return load();
      })
      .catch((e: unknown) => setMessage((e as Error).message))
      .finally(() => setBusy(false));
  };
  const armed = (alerts ?? []).filter((a) => a.firedAt === null);
  const fired = (alerts ?? []).filter((a) => a.firedAt !== null);

  return (
    <section className="tk-card pa" aria-label={`${ticker} price alerts`}>
      <h3>Price alerts</h3>
      <form
        className="pa-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || busy) return;
          run(
            async () => {
              await send("POST", "/api/price-alerts", {
                ticker,
                kind,
                value: n,
                ...(note.trim() ? { note: note.trim() } : {}),
              });
              setValue("");
              setNote("");
            },
            `Alert set: ${alertRule({ kind, value: n })}.`,
          );
        }}
      >
        <select
          aria-label="Alert when"
          value={kind}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value as PriceAlertKind;
            setKind(next);
            setValue(
              next === "above" && last
                ? (last * 1.02).toFixed(2)
                : next === "below" && last
                  ? (last * 0.98).toFixed(2)
                  : "3",
            );
          }}
        >
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
        <label className="pa-value">
          {unit === "$" && <span aria-hidden="true">$</span>}
          <input
            className="num"
            inputMode="decimal"
            aria-label={unit === "$" ? "Price" : "Percent"}
            placeholder={unit === "$" ? (last?.toFixed(2) ?? "Price") : "3"}
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))}
          />
          {unit === "%" && <span aria-hidden="true">%</span>}
        </label>
        <input
          className="pa-note"
          aria-label="Note (optional)"
          placeholder="Note (optional)"
          maxLength={80}
          value={note}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
        />
        <button type="submit" className="pos-go" disabled={!valid || busy}>
          {busy ? "Saving…" : "Add alert"}
        </button>
      </form>
      <p className="muted pa-hint">
        {already
          ? `${ticker} is already there (${last!.toFixed(2)}): it will fire within a minute.`
          : "Checked every minute, pre- and after-hours too. Each alert is sent once to Telegram, on your phone."}
      </p>
      {message && (
        <p className="pa-message" role="status">
          {message}
        </p>
      )}
      {alerts && alerts.length === 0 && (
        <p className="muted">No price alerts on {ticker}.</p>
      )}
      {(armed.length > 0 || fired.length > 0) && (
        <ul className="tk-list num">
          {armed.map((a) => (
            <li key={a.id}>
              <span>
                {alertRule(a)}
                {a.note && <small className="muted"> · {a.note}</small>}
              </span>
              <button
                type="button"
                className="action"
                disabled={busy}
                aria-label={`Delete the alert ${alertRule(a)}`}
                onClick={() =>
                  run(
                    () => send("DELETE", `/api/price-alerts/${a.id}`),
                    "Alert deleted.",
                  )
                }
              >
                Delete
              </button>
            </li>
          ))}
          {fired.map((a) => (
            <li key={a.id} className="pa-fired">
              <span>
                {alertRule(a)}
                <small className="muted">
                  {" "}
                  · fired {clock.format(a.firedAt!)} at{" "}
                  {a.firedPrice?.toFixed(2)}
                </small>
              </span>
              <span className="pa-actions">
                <button
                  type="button"
                  className="action"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => send("POST", `/api/price-alerts/${a.id}/rearm`),
                      "Armed again.",
                    )
                  }
                >
                  Arm again
                </button>
                <button
                  type="button"
                  className="action"
                  disabled={busy}
                  aria-label={`Delete the alert ${alertRule(a)}`}
                  onClick={() =>
                    run(
                      () => send("DELETE", `/api/price-alerts/${a.id}`),
                      "Alert deleted.",
                    )
                  }
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
