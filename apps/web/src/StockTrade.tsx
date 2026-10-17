import { useEffect, useRef, useState } from "react";
import { readJson } from "./api.js";
import { followOrder, type Run } from "./order-run.js";
import {
  allowedTimeInForce,
  blankForm,
  changeBody,
  changeable,
  describeOrder,
  extendedAllowed,
  money,
  ticketBody,
  ticketTypes,
  tifLabels,
  typeExplained,
  withType,
  type OpenStockOrder,
  type TicketForm,
} from "./stock-ticket-model.js";

// Stocks in the trade ticket: whole shares, long only (user 2026-10-16), with
// every order type and time in force a broker offers (user 2026-10-17). No
// size check and no automatic stop, by the user's choice. A sale never goes
// beyond the shares held and not already offered: the trading service refuses
// it, and checks every order before it is sent.

export interface StockQuoteView {
  symbol: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  quotedAt: string | null;
  marketOpen: boolean | null;
  held: number;
  avgEntryPrice: number | null;
  sellable: number;
  buyPrice: number | null;
  sellPrice: number | null;
  openOrders: OpenStockOrder[];
}

// What `…/stock/check` and `…/stock/order` answer.
interface TicketAnswer {
  status: "checked" | "sent";
  paper?: boolean;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  type: string;
  timeInForce: string;
  limitPrice?: number;
  stopPrice?: number;
  trailPercent?: number;
  trailPrice?: number;
  extendedHours?: boolean;
  estimatedCost: number | null;
  notes: string[];
  orderId?: string;
  orderStatus?: string;
  filledQty?: number;
  avgPrice?: number | null;
  shortRisks?: string[];
}

const quoteRefreshMs = 2000;
const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

async function post<T>(path: string, body: unknown): Promise<T> {
  return readJson<T>(
    await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    }),
  );
}

function RunStatus({ run }: { run: Run }) {
  return (
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
  );
}

type Phase =
  | { step: "idle" }
  | { step: "checking" }
  | { step: "checked"; answer: TicketAnswer }
  | { step: "sending" }
  | { step: "sent"; answer: TicketAnswer }
  | { step: "failed"; message: string };

const answerLine = (a: TicketAnswer) =>
  describeOrder({
    orderId: "",
    side: a.side,
    type: a.type,
    timeInForce: a.timeInForce,
    qty: a.qty,
    filledQty: 0,
    price: null,
    limitPrice: a.limitPrice ?? null,
    stopPrice: a.stopPrice ?? null,
    trailPercent: a.trailPercent ?? null,
    trailPrice: a.trailPrice ?? null,
    extendedHours: a.extendedHours === true,
  }) + (a.estimatedCost === null ? "" : ` · about ${usd(a.estimatedCost)}`);

function OrderTicket({ q }: { q: StockQuoteView }) {
  const [f, setF] = useState<TicketForm>(blankForm);
  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  const [run, setRun] = useState<Run>({ step: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    // Set again on a remount (React's development mode mounts twice).
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const busy =
    phase.step === "checking" ||
    phase.step === "sending" ||
    run.step === "sending" ||
    run.step === "working";
  // Every change asks for a new check.
  const set = (next: Partial<TicketForm> | ((f: TicketForm) => TicketForm)) => {
    setF((was) =>
      typeof next === "function" ? next(was) : { ...was, ...next },
    );
    setPhase({ step: "idle" });
    setRun({ step: "idle" });
  };
  // A price field starts at the side's quote.
  const near = (side: TicketForm["side"]) =>
    money(side === "buy" ? (q.ask ?? q.last) : (q.bid ?? q.last));
  const chooseType = (type: TicketForm["type"]) =>
    set((was) => {
      const next = withType(was, type);
      if ((type === "limit" || type === "stop_limit") && !next.limit)
        next.limit = near(was.side);
      if ((type === "stop" || type === "stop_limit") && !next.stop)
        next.stop = money(q.last ?? q.bid);
      return next;
    });
  const chooseSide = (side: TicketForm["side"]) =>
    set((was) => ({
      ...was,
      side,
      unit: "qty",
      size: side === "sell" ? "all" : "1",
      limit: was.limit && near(side),
      stop: was.stop,
    }));

  const sell = f.side === "sell";
  const ready = ticketBody(q.symbol, f);
  const auto = f.type === "auto";
  const sellShares =
    f.size === "all"
      ? q.sellable
      : f.size === "half"
        ? Math.max(1, Math.floor(q.sellable / 2))
        : Number(f.size);
  const tooMany = sell && sellShares > q.sellable;
  const tifs = auto
    ? []
    : allowedTimeInForce[f.type as keyof typeof allowedTimeInForce];

  const check = async () => {
    if (!("body" in ready)) return;
    setPhase({ step: "checking" });
    try {
      const answer = await post<TicketAnswer>(
        "/api/portfolio/control/stock/check",
        ready.body,
      );
      if (alive.current) setPhase({ step: "checked", answer });
    } catch (e) {
      if (alive.current)
        setPhase({ step: "failed", message: (e as Error).message });
    }
  };
  const send = async () => {
    if (!("body" in ready)) return;
    setPhase({ step: "sending" });
    try {
      const answer = await post<TicketAnswer>(
        "/api/portfolio/control/stock/order",
        ready.body,
      );
      if (alive.current) setPhase({ step: "sent", answer });
    } catch (e) {
      if (alive.current)
        setPhase({ step: "failed", message: (e as Error).message });
    }
  };

  return (
    <section className="ticket" aria-label={`Order ${q.symbol} shares`}>
      <div className="segmented ticket-side" role="group" aria-label="Side">
        <button
          type="button"
          aria-pressed={!sell}
          disabled={busy}
          onClick={() => chooseSide("buy")}
        >
          Buy
        </button>
        <button
          type="button"
          className="sell"
          aria-pressed={sell}
          disabled={busy || q.sellable < 1}
          title={
            q.sellable < 1
              ? q.held > 0
                ? "Every share is already offered by an open sell"
                : `No ${q.symbol} shares held: a sale would go short`
              : undefined
          }
          onClick={() => chooseSide("sell")}
        >
          Sell
        </button>
      </div>
      {q.held > 0 && (
        <p className="muted num">
          {q.held} held
          {q.avgEntryPrice !== null && ` @ ${money(q.avgEntryPrice)}`}
          {q.sellable < q.held && ` · ${q.sellable} free to sell`}
        </p>
      )}

      <div className="ticket-fields">
        <label className="ticket-field">
          <span>Order type</span>
          <select
            value={f.type}
            disabled={busy}
            onChange={(e) => chooseType(e.target.value as TicketForm["type"])}
          >
            {ticketTypes.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {!auto && (
          <label className="ticket-field">
            <span>Time in force</span>
            <select
              value={f.tif}
              disabled={busy}
              onChange={(e) =>
                set((was) => {
                  const tif = e.target.value as TicketForm["tif"];
                  return {
                    ...was,
                    tif,
                    extended: was.extended && extendedAllowed(was.type, tif),
                  };
                })
              }
            >
              {tifs.map((t) => (
                <option key={t} value={t}>
                  {tifLabels[t]}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="ticket-explain muted">{typeExplained[f.type]}</p>

        <div className="ticket-field">
          <span id="stock-size">{sell ? "Shares" : "Size"}</span>
          <div className="ticket-size">
            <input
              className="num"
              inputMode="decimal"
              aria-labelledby="stock-size"
              value={
                sell && (f.size === "all" || f.size === "half")
                  ? String(sellShares)
                  : f.size
              }
              disabled={busy}
              onChange={(e) =>
                set({
                  size: e.target.value.replace(sell ? /\D/g : /[^\d.]/g, ""),
                })
              }
            />
            {sell ? (
              <div className="segmented" role="group" aria-label="How many">
                {(["half", "all"] as const).map((k) => (
                  <button
                    type="button"
                    key={k}
                    aria-pressed={f.size === k}
                    disabled={busy}
                    onClick={() => set({ size: k })}
                  >
                    {k === "all" ? "All" : "Half"}
                  </button>
                ))}
              </div>
            ) : (
              <div className="segmented" role="group" aria-label="Size unit">
                <button
                  type="button"
                  aria-pressed={f.unit === "qty"}
                  disabled={busy}
                  onClick={() => set({ unit: "qty", size: "1" })}
                >
                  Shares
                </button>
                <button
                  type="button"
                  aria-pressed={f.unit === "usd"}
                  disabled={busy}
                  onClick={() => set({ unit: "usd", size: "1000" })}
                >
                  Dollars
                </button>
              </div>
            )}
          </div>
        </div>

        {(f.type === "stop" || f.type === "stop_limit") && (
          <label className="ticket-field">
            <span>Stop price</span>
            <input
              className="num"
              inputMode="decimal"
              value={f.stop}
              disabled={busy}
              onChange={(e) =>
                set({ stop: e.target.value.replace(/[^\d.]/g, "") })
              }
            />
          </label>
        )}
        {(f.type === "limit" || f.type === "stop_limit") && (
          <label className="ticket-field">
            <span>Limit price</span>
            <input
              className="num"
              inputMode="decimal"
              value={f.limit}
              disabled={busy}
              onChange={(e) =>
                set({ limit: e.target.value.replace(/[^\d.]/g, "") })
              }
            />
          </label>
        )}
        {f.type === "trailing_stop" && (
          <div className="ticket-field">
            <span id="stock-trail">Trail by</span>
            <div className="ticket-size">
              <input
                className="num"
                inputMode="decimal"
                aria-labelledby="stock-trail"
                value={f.trail}
                disabled={busy}
                onChange={(e) =>
                  set({ trail: e.target.value.replace(/[^\d.]/g, "") })
                }
              />
              <div className="segmented" role="group" aria-label="Trail unit">
                <button
                  type="button"
                  aria-pressed={f.trailBy === "percent"}
                  disabled={busy}
                  onClick={() => set({ trailBy: "percent", trail: "5" })}
                >
                  %
                </button>
                <button
                  type="button"
                  aria-pressed={f.trailBy === "price"}
                  disabled={busy}
                  onClick={() => set({ trailBy: "price", trail: "1.00" })}
                >
                  $
                </button>
              </div>
            </div>
          </div>
        )}
        {extendedAllowed(f.type, f.tif) && (
          <label className="ticket-force">
            <input
              type="checkbox"
              checked={f.extended}
              disabled={busy}
              onChange={(e) => set({ extended: e.target.checked })}
            />
            Also fill in pre- and after-hours
          </label>
        )}
      </div>

      {tooMany && (
        <p className="note-amber" role="status">
          Only {q.sellable} can be sold: a sale never goes short.
        </p>
      )}
      {"problem" in ready && f.size !== "" && (
        <p className="muted">{ready.problem}</p>
      )}

      {auto ? (
        run.step === "confirm" ? (
          <div className="pos-confirm" role="group" aria-label="Confirm">
            <span>
              {sell ? "Sell" : "Buy"}{" "}
              {sell
                ? sellShares
                : f.unit === "usd"
                  ? usd(Number(f.size))
                  : f.size}{" "}
              {q.symbol}, stepped from {money(sell ? q.sellPrice : q.buyPrice)}{" "}
              to the {sell ? `bid ${money(q.bid)}` : `ask ${money(q.ask)}`}?
            </span>
            <button
              type="button"
              className="pos-go"
              onClick={() =>
                "body" in ready &&
                void followOrder(
                  `/api/portfolio/control/stock/${f.side}`,
                  ready.body,
                  !sell,
                  setRun,
                  alive,
                )
              }
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
            className={sell ? "pos-go sell" : "pos-go"}
            disabled={busy || !("body" in ready) || tooMany}
            onClick={() => setRun({ step: "confirm" })}
          >
            {busy ? "Working…" : `${sell ? "Sell" : "Buy"} ${q.symbol}`}
          </button>
        )
      ) : phase.step === "checked" ? (
        <div className="ticket-check">
          <p className="ticket-summary num">
            <strong>{answerLine(phase.answer)}</strong>
            {phase.answer.paper && " · paper account"}
          </p>
          {phase.answer.notes.length > 0 && (
            <ul className="ticket-notes">
              {phase.answer.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <div className="pos-confirm" role="group" aria-label="Confirm">
            <button
              type="button"
              className={sell ? "pos-go sell" : "pos-go"}
              onClick={() => void send()}
            >
              Confirm {sell ? "sell" : "buy"}
            </button>
            <button
              type="button"
              className="pos-cancel"
              onClick={() => setPhase({ step: "idle" })}
            >
              Edit
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={sell ? "pos-go sell" : "pos-go"}
          disabled={busy || !("body" in ready) || tooMany}
          onClick={() => void check()}
        >
          {phase.step === "checking"
            ? "Checking…"
            : phase.step === "sending"
              ? "Sending…"
              : `Review ${sell ? "sell" : "buy"}`}
        </button>
      )}

      {auto && <RunStatus run={run} />}
      {phase.step === "failed" && (
        <p className="pos-run pos-problem" role="alert">
          {phase.message}
        </p>
      )}
      {phase.step === "sent" && (
        <p className="pos-run" role="status">
          <span>
            Sent: {answerLine(phase.answer)}.{" "}
            {phase.answer.orderStatus?.replaceAll("_", " ")}
            {(phase.answer.filledQty ?? 0) > 0 &&
              ` · ${phase.answer.filledQty} filled at ${money(phase.answer.avgPrice)}`}
          </span>
          {phase.answer.shortRisks?.length ? (
            <span className="pos-problem">
              Short position risk: {phase.answer.shortRisks.join("; ")}
            </span>
          ) : null}
        </p>
      )}
    </section>
  );
}

function OpenOrderRow({ o }: { o: OpenStockOrder }) {
  const has = changeable(o);
  const fresh = () => ({
    qty: String(o.qty),
    limit: has.limit ? money(o.limitPrice ?? o.price) : "",
    stop: money(o.stopPrice),
    trail: String(o.trailPercent ?? o.trailPrice ?? ""),
  });
  const [mode, setMode] = useState<"view" | "change" | "cancel">("view");
  const [edit, setEdit] = useState(fresh);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const change = changeBody(o, edit);
  const act = (path: string, body: unknown, done: string) => {
    setBusy(true);
    setMessage("");
    post(path, body)
      .then(() => {
        setMessage(done);
        setMode("view");
      })
      .catch((e: unknown) => setMessage((e as Error).message))
      .finally(() => setBusy(false));
  };
  const field = (key: keyof typeof edit, label: string, show: boolean) =>
    show && (
      <label className="ticket-field">
        <span>{label}</span>
        <input
          className="num"
          inputMode="decimal"
          value={edit[key]}
          disabled={busy}
          onChange={(e) =>
            setEdit({ ...edit, [key]: e.target.value.replace(/[^\d.]/g, "") })
          }
        />
      </label>
    );
  return (
    <li className="stock-order">
      <span className="num">{describeOrder(o)}</span>
      {mode === "view" && (
        <span className="stock-order-actions">
          <button
            type="button"
            className="action"
            onClick={() => {
              setEdit(fresh());
              setMessage("");
              setMode("change");
            }}
          >
            Change
          </button>
          <button
            type="button"
            className="action"
            onClick={() => {
              setMessage("");
              setMode("cancel");
            }}
          >
            Cancel order
          </button>
        </span>
      )}
      {mode === "cancel" && (
        <span className="stock-order-actions">
          <button
            type="button"
            className="action danger"
            disabled={busy}
            onClick={() =>
              act(
                "/api/portfolio/control/cancel",
                { orderId: o.orderId },
                "Canceled.",
              )
            }
          >
            {busy ? "Canceling…" : "Yes, cancel it"}
          </button>
          <button
            type="button"
            className="action"
            onClick={() => setMode("view")}
          >
            Keep it
          </button>
        </span>
      )}
      {mode === "change" && (
        <div className="ticket-fields">
          {field("qty", "Shares (total)", true)}
          {field("stop", "Stop price", has.stop)}
          {field("limit", "Limit price", has.limit)}
          {field(
            "trail",
            o.trailPrice != null ? "Trail $" : "Trail %",
            has.trail,
          )}
          <span className="stock-order-actions">
            <button
              type="button"
              className="action primary"
              disabled={busy || !change || !("body" in change)}
              onClick={() =>
                change &&
                "body" in change &&
                act("/api/portfolio/control/change", change.body, "Changed.")
              }
            >
              {busy ? "Saving…" : "Save change"}
            </button>
            <button
              type="button"
              className="action"
              onClick={() => setMode("view")}
            >
              Back
            </button>
          </span>
          {change && "problem" in change && (
            <p className="muted">{change.problem}</p>
          )}
        </div>
      )}
      {message && (
        <p className="pos-run" role="status">
          {message}
        </p>
      )}
    </li>
  );
}

export function StockTrade({ symbol }: { symbol: string }) {
  const [q, setQ] = useState<StockQuoteView | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setQ(null);
    setError("");
    const load = async () => {
      try {
        const next = await readJson<StockQuoteView>(
          await fetch(
            `/api/portfolio/control/stock/quote?symbol=${encodeURIComponent(symbol)}`,
            { signal: AbortSignal.timeout(15000) },
          ),
        );
        if (live) {
          setQ(next);
          setError("");
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "No quote");
      }
    };
    void load();
    const timer = setInterval(load, quoteRefreshMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [symbol]);

  if (error && !q) return <p className="notice error">{error}</p>;
  if (!q) return <p className="chart-status">Loading {symbol}…</p>;
  return (
    <>
      <p className="ticket-summary num">
        <strong>{q.symbol}</strong> bid {money(q.bid)} · ask {money(q.ask)} ·
        last {money(q.last)}
        {q.marketOpen === false && " · market closed"}
      </p>
      <OrderTicket key={q.symbol} q={q} />
      {q.openOrders.length > 0 && (
        <section className="ticket" aria-label={`Open ${q.symbol} orders`}>
          <h3>Open {q.symbol} orders</h3>
          <ul className="stock-orders">
            {q.openOrders.map((o) => (
              <OpenOrderRow key={o.orderId} o={o} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
