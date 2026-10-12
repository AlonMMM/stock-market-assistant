import { useEffect, useRef, useState } from "react";
import type {
  PortfolioOrder,
  PortfolioPosition,
} from "../../../packages/trading/src/portfolio.js";
import { readJson } from "./api.js";

// The owner's controls for what is already at the broker: moving a
// position's stop, withdrawing an open order, and changing the price of a buy
// that is waiting or working. Each answers at once; the page's next refresh
// shows the new state.

type Result = { ok: boolean; text: string } | null;

/** Sends one action to an owner-only route and keeps its outcome. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function run<T>(path: string, body: unknown, done: (r: T) => string) {
    setBusy(true);
    setResult(null);
    try {
      const answer = await readJson<T>(
        await fetch(`/api/portfolio/control/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        }),
      );
      if (alive.current) setResult({ ok: true, text: done(answer) });
    } catch (error) {
      if (alive.current)
        setResult({
          ok: false,
          text: error instanceof Error ? error.message : "The request failed",
        });
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return { busy, result, run, clear: () => setResult(null) };
}

const priceText = (value: string) => value.replace(/[^\d.]/g, "");

/** Move the position's stop to a price, or set one where there is none. */
export function StopMover({ p }: { p: PortfolioPosition }) {
  const suggested = p.stop?.price ?? p.entry * 0.6;
  const [value, setValue] = useState(suggested.toFixed(2));
  const { busy, result, run, clear } = useAction();
  const price = Number(value);
  const valid = price > 0;
  const below = valid && p.entry > 0 ? (1 - price / p.entry) * 100 : null;
  const same = p.stop !== null && Math.abs(price - p.stop.price) < 0.005;
  return (
    <form
      className="order-edit"
      onSubmit={(e) => {
        e.preventDefault();
        void run<{ price: number; qty: number }>(
          "stop",
          { contract: p.symbol, price },
          (r) => `Stop is now ${r.price.toFixed(2)} on ${r.qty}.`,
        );
      }}
    >
      <label>
        <span>{p.stop ? "Move the stop to" : "Set a stop at"}</span>
        <input
          className="num"
          inputMode="decimal"
          value={value}
          disabled={busy}
          onChange={(e) => {
            setValue(priceText(e.target.value));
            clear();
          }}
        />
      </label>
      <button
        type="submit"
        className="pos-cancel"
        disabled={busy || !valid || same}
      >
        {busy ? "Working…" : p.stop ? "Move stop" : "Set stop"}
      </button>
      <span
        className={
          result && !result.ok ? "order-note pos-problem" : "order-note"
        }
        role="status"
      >
        {result
          ? result.text
          : below === null
            ? ""
            : below >= 0
              ? `${below.toFixed(0)}% below the entry ${p.entry.toFixed(2)}`
              : `${(-below).toFixed(0)}% above the entry ${p.entry.toFixed(2)}: locks in a gain`}
      </span>
    </form>
  );
}

/** Withdraw an open order, or change the price of a working buy. */
export function OrderActions({ o }: { o: PortfolioOrder }) {
  const isStop = o.stopPrice !== null;
  const canPrice = o.side === "buy" && !isStop && o.limitPrice !== null;
  const [value, setValue] = useState(o.limitPrice?.toFixed(2) ?? "");
  const [confirming, setConfirming] = useState(false);
  const { busy, result, run, clear } = useAction();
  const price = Number(value);
  const changed =
    canPrice && price > 0 && Math.abs(price - o.limitPrice!) >= 0.005;
  return (
    <div className="order-actions">
      {canPrice && (
        <form
          className="order-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void run<{ price: number }>(
              "price",
              { orderId: o.id, price },
              (r) => `Price changed to ${r.price.toFixed(2)}.`,
            );
          }}
        >
          <label>
            <span>Limit price</span>
            <input
              className="num"
              inputMode="decimal"
              value={value}
              disabled={busy}
              onChange={(e) => {
                setValue(priceText(e.target.value));
                clear();
              }}
            />
          </label>
          <button
            type="submit"
            className="pos-cancel"
            disabled={busy || !changed}
          >
            Change price
          </button>
        </form>
      )}
      {confirming ? (
        <span className="order-confirm" role="group" aria-label="Confirm">
          <span>
            {isStop
              ? "Cancel the stop? Its contracts will have no stop."
              : "Cancel this order?"}
          </span>
          <button
            type="button"
            className="pos-go sell"
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              void run<{ canceled: string; warning?: string }>(
                "cancel",
                { orderId: o.id },
                (r) => r.warning ?? `Canceled ${r.canceled}.`,
              );
            }}
          >
            Yes, cancel
          </button>
          <button
            type="button"
            className="pos-cancel"
            onClick={() => setConfirming(false)}
          >
            Keep
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="pos-cancel"
          disabled={busy}
          onClick={() => {
            clear();
            setConfirming(true);
          }}
        >
          {busy ? "Working…" : isStop ? "Cancel stop" : "Cancel order"}
        </button>
      )}
      {result && (
        <span
          className={result.ok ? "order-note" : "order-note pos-problem"}
          role="status"
        >
          {result.text}
        </span>
      )}
    </div>
  );
}
