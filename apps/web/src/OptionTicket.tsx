import { useEffect, useRef, useState, type FormEvent } from "react";
import type { TradeEngine } from "../../../packages/trading/src/engine.js";
import { readJson } from "./api.js";
import { followOrder, type Run } from "./order-run.js";
import {
  blankTicket,
  onOptionTick,
  orderTypes,
  stepOptionPrice,
  stepped,
  ticketBody,
  ticketLine,
  type TicketForm,
} from "./option-ticket-model.js";

// The option buy ticket (user 2026-10-18), laid out like a broker's order
// panel: the quote, quantity, order type and time in force, the prices the
// type needs, "try to buy and increase" and "auto stop", then Preview →
// Submit → Confirm. Beside the chain on a wide screen; on a phone it is a
// sheet over the bottom of the screen (`sheet`).

type Chain = Awaited<ReturnType<TradeEngine["chainFor"]>>;
type Check = Awaited<ReturnType<TradeEngine["checkContract"]>>;
type Quote = Chain["quotes"][number];

const price = (n: number) => (n > 0 ? n.toFixed(2) : "—");
const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function PriceField({
  id,
  label,
  value,
  busy,
  quote,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  busy: boolean;
  quote: Quote;
  onChange: (v: string) => void;
}) {
  const n = Number(value);
  return (
    <div className="ot-field ot-wide">
      <span id={id}>{label}</span>
      <div className="ot-price">
        <div className="ot-stepper">
          <button
            type="button"
            aria-label={`${label}: one tick lower`}
            disabled={busy || !(n > 0.01)}
            onClick={() => onChange(stepOptionPrice(n, false).toFixed(2))}
          >
            −
          </button>
          <input
            className="num"
            inputMode="decimal"
            aria-labelledby={id}
            value={value}
            disabled={busy}
            onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
          />
          <button
            type="button"
            aria-label={`${label}: one tick higher`}
            disabled={busy}
            onClick={() => onChange(stepOptionPrice(n || 0, true).toFixed(2))}
          >
            +
          </button>
        </div>
        <div className="segmented" role="group" aria-label={`${label} from`}>
          {(
            [
              ["Bid", quote.bid],
              ["Mid", quote.mid],
              ["Ask", quote.ask],
            ] as const
          ).map(([name, v]) => (
            <button
              type="button"
              key={name}
              aria-pressed={v > 0 && onOptionTick(v) === n}
              disabled={busy || !(v > 0)}
              onClick={() => onChange(onOptionTick(v).toFixed(2))}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function OptionTicket({
  chain,
  quote,
  name,
  sheet,
}: {
  chain: Chain;
  quote: Quote;
  name: string;
  // On a phone: the sheet, open or folded to its title bar.
  sheet?: { open: boolean; toggle: () => void };
}) {
  const [f, setF] = useState<TicketForm>(() =>
    blankTicket(quote.mid || quote.ask),
  );
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [run, setRun] = useState<Run>({ step: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Any change makes the last check stale.
  const set = (next: Partial<TicketForm>) => {
    setF((was) => ({ ...was, ...next }));
    setCheck(null);
    setError("");
    setRun({ step: "idle" });
  };
  const busy = run.step === "sending" || run.step === "working";
  const ready = ticketBody(quote.contract, f);
  const isStepped = stepped(f);
  const needsLimit = f.type === "limit" || f.type === "stop_limit";
  const needsStop = f.type === "stop" || f.type === "stop_limit";

  async function preview(event: FormEvent) {
    event.preventDefault();
    if (!("body" in ready)) return;
    setChecking(true);
    setError("");
    try {
      const result = await readJson<Check>(
        await fetch("/api/portfolio/control/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ready.body),
          signal: AbortSignal.timeout(30000),
        }),
      );
      if (alive.current) setCheck(result);
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "The check failed");
    } finally {
      if (alive.current) setChecking(false);
    }
  }
  const send = () =>
    "body" in ready &&
    void followOrder(
      "/api/portfolio/control/buy",
      ready.body,
      true,
      setRun,
      alive,
    );
  const folded = sheet && !sheet.open;

  return (
    <form
      className={`ot${sheet ? " ot-sheet" : ""}${folded ? " folded" : ""}`}
      onSubmit={preview}
      aria-label={`Buy ${name}`}
    >
      <div className="ot-head">
        {sheet && (
          <button
            type="button"
            className="ot-grip"
            aria-expanded={sheet.open}
            aria-label={sheet.open ? "Fold the order" : "Open the order"}
            onClick={sheet.toggle}
          />
        )}
        <h3>
          <span className="ot-buy">BUY</span> {name}
        </h3>
        <span className="muted num">
          {price(quote.bid)} × {price(quote.ask)}
        </span>
        {folded && (
          <button
            type="button"
            className="pos-go ot-open"
            onClick={sheet.toggle}
          >
            Order
          </button>
        )}
      </div>
      {!folded && (
        <>
          <dl className="ot-quote num">
            {(
              [
                ["Bid", price(quote.bid)],
                ["Mid", price(quote.mid)],
                ["Ask", price(quote.ask)],
                [
                  "Spread",
                  quote.spreadPct === null
                    ? "—"
                    : `${quote.spreadPct.toFixed(1)}%`,
                ],
                ["Delta", quote.delta === null ? "—" : quote.delta.toFixed(2)],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>

          <div className="ot-fields">
            <div className="ot-field">
              <span id="ot-size">Quantity</span>
              <div className="ot-row">
                <input
                  className="num ot-size"
                  inputMode="decimal"
                  aria-labelledby="ot-size"
                  value={f.size}
                  disabled={busy}
                  onChange={(e) =>
                    set({ size: e.target.value.replace(/[^\d.]/g, "") })
                  }
                />
                <div className="segmented" role="group" aria-label="Size unit">
                  <button
                    type="button"
                    aria-pressed={f.unit === "qty"}
                    disabled={busy}
                    onClick={() => set({ unit: "qty", size: "1" })}
                  >
                    Contracts
                  </button>
                  <button
                    type="button"
                    aria-pressed={f.unit === "pct"}
                    disabled={busy}
                    onClick={() => set({ unit: "pct", size: "0.5" })}
                  >
                    % acct
                  </button>
                </div>
              </div>
            </div>
            <label className="ot-field">
              <span>Order type</span>
              <select
                value={f.type}
                disabled={busy}
                onChange={(e) => {
                  const type = e.target.value as TicketForm["type"];
                  // A stop starts 10% above the ask; a stop limit's limit
                  // a little above its stop, so it can fill once triggered.
                  const stop =
                    f.stop ||
                    (type === "stop" || type === "stop_limit"
                      ? onOptionTick(quote.ask * 1.1).toFixed(2)
                      : "");
                  set({
                    type,
                    stop,
                    ...(type === "stop_limit"
                      ? {
                          limit: onOptionTick(Number(stop) * 1.05).toFixed(2),
                        }
                      : {}),
                  });
                }}
              >
                {orderTypes.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="ot-field">
              <span>Time in force</span>
              <select
                value={isStepped ? "day" : f.tif}
                disabled={busy || isStepped}
                onChange={(e) =>
                  set({ tif: e.target.value as TicketForm["tif"] })
                }
              >
                <option value="day">Day</option>
                <option value="gtc">GTC</option>
              </select>
            </label>
            <p className="ot-hint muted">
              {orderTypes.find((t) => t.type === f.type)!.hint}
            </p>

            {f.type === "limit" && (
              <label className="ot-check ot-wide">
                <input
                  type="checkbox"
                  checked={f.ladder}
                  disabled={busy}
                  onChange={(e) => set({ ladder: e.target.checked })}
                />
                <span>
                  Try to buy and increase
                  <small className="muted">
                    {f.ladder
                      ? `from the mid ${price(quote.mid)} toward the ask ${price(quote.ask)}`
                      : "off: one order at your price"}
                  </small>
                </span>
              </label>
            )}
            {needsStop && (
              <PriceField
                id="ot-stop"
                label="Stop price"
                value={f.stop}
                busy={busy}
                quote={quote}
                onChange={(stop) => set({ stop })}
              />
            )}
            {needsLimit && !isStepped && (
              <PriceField
                id="ot-limit"
                label="Limit price"
                value={f.limit}
                busy={busy}
                quote={quote}
                onChange={(limit) => set({ limit })}
              />
            )}
            <div className="ot-check ot-wide">
              <label>
                <input
                  type="checkbox"
                  checked={f.autoStop}
                  disabled={busy}
                  onChange={(e) => set({ autoStop: e.target.checked })}
                />
                <span>
                  Auto stop
                  {!f.autoStop && (
                    <small className="muted">
                      off: the whole premium is at risk
                    </small>
                  )}
                </span>
              </label>
              {f.autoStop && (
                <span className="ot-stop-pct">
                  <input
                    className="num"
                    inputMode="decimal"
                    aria-label="Stop, % below the price paid"
                    value={f.stopPct}
                    disabled={busy}
                    onChange={(e) =>
                      set({ stopPct: e.target.value.replace(/[^\d.]/g, "") })
                    }
                  />
                  <span className="muted">% below the price paid</span>
                </span>
              )}
            </div>
            <label className="ot-check ot-wide">
              <input
                type="checkbox"
                checked={f.force}
                disabled={busy}
                onChange={(e) => set({ force: e.target.checked })}
              />
              <span>
                Force
                <small className="muted">
                  buy whatever the spread is (otherwise at most{" "}
                  {chain.maxSpreadPct}% of the mid)
                </small>
              </span>
            </label>
          </div>

          <p className="ot-line muted">{ticketLine(f, quote.ask)}</p>
          {"problem" in ready && (
            <p className="pos-problem ot-line">{ready.problem}</p>
          )}
          {!check && (
            <button
              type="submit"
              className="pos-go"
              disabled={checking || !("body" in ready)}
            >
              {checking ? "Checking…" : "Preview order"}
            </button>
          )}
          {error && <p className="notice error">{error}</p>}
          {check && (
            <div className="ot-check-result">
              <dl className="ot-quote num">
                <div>
                  <dt>Contracts</dt>
                  <dd>{check.qty}</dd>
                </div>
                <div>
                  <dt>
                    {check.orderType === null
                      ? "Up to"
                      : check.orderType === "market"
                        ? "At about"
                        : "Counted at"}
                  </dt>
                  <dd>{check.ceiling.toFixed(2)}</dd>
                </div>
                <div>
                  <dt>Max cost</dt>
                  <dd>{usd(check.maxCost)}</dd>
                </div>
                <div>
                  <dt>Of account</dt>
                  <dd>{check.sizePct.toFixed(2)}%</dd>
                </div>
                <div>
                  <dt>Stop</dt>
                  <dd>
                    {!check.autoStop
                      ? "none"
                      : check.stopAtCeiling === null
                        ? "—"
                        : `≈ ${check.stopAtCeiling.toFixed(2)}`}
                  </dd>
                </div>
              </dl>
              {check.qty === 0 && (
                <p className="ot-line">No whole contract fits this size.</p>
              )}
              {!check.marketOpen && (
                <p className="ot-line">
                  The market is closed: the order waits for the open.
                </p>
              )}
              {check.notes.length > 0 && (
                <ul className="ticket-notes">
                  {check.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              <details className="ot-checks" open={!check.wouldBuy}>
                <summary>
                  {check.wouldBuy
                    ? `All ${check.checks.length} checks pass`
                    : `${check.checks.filter((c) => !c.ok).length} check(s) failed`}
                </summary>
                <ul className="why-checks">
                  {check.checks.map((c) => (
                    <li
                      key={c.check + c.detail}
                      className={c.ok ? "ok" : "bad"}
                    >
                      <span aria-hidden="true">{c.ok ? "✓" : "✕"}</span>
                      <strong>{c.check}</strong>
                      <span className="muted">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              </details>
              {!check.wouldBuy ? (
                <p className="note-amber" role="status">
                  This order would be refused. Change it and preview again.
                </p>
              ) : run.step === "confirm" ? (
                <div
                  className="pos-confirm"
                  role="group"
                  aria-label="Confirm the order"
                >
                  <span>
                    Buy {check.qty} {name}, at most {usd(check.maxCost)},{" "}
                    {check.autoStop ? "with a stop" : "with no stop"}
                    {check.paper ? ", on the paper account" : ""}?
                  </span>
                  <button type="button" className="pos-go" onClick={send}>
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
                run.step !== "ended" && (
                  <button
                    type="button"
                    className="pos-go"
                    disabled={busy}
                    onClick={() => setRun({ step: "confirm" })}
                  >
                    {busy
                      ? "Working…"
                      : `Submit: buy ${check.qty} contract${check.qty === 1 ? "" : "s"}`}
                  </button>
                )
              )}
            </div>
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
          </p>
        </>
      )}
    </form>
  );
}
