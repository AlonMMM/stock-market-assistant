import { useEffect, useRef, useState } from "react";
import { readJson } from "./api.js";
import { followOrder, type Run } from "./order-run.js";

// Stocks in the trade ticket (user 2026-10-16): whole shares, long only. A
// limit order starts at the mid and steps toward the ask (buy) or the bid
// (sell); it may fill in pre- and after-hours. No size check and no
// automatic stop, by the user's choice. A sale never goes beyond the shares
// held: the trading service refuses it.

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
  openOrders: {
    orderId: string;
    side: string;
    qty: number;
    filledQty: number;
    price: number | null;
  }[];
}

const quoteRefreshMs = 2000;
const money = (n: number | null) =>
  n === null ? "—" : n >= 1 ? n.toFixed(2) : n.toFixed(4);
const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/** Whole shares a buy asks for, from shares or dollars at the ask. */
export function buyShares(
  unit: "qty" | "usd",
  size: string,
  ask: number | null,
): number {
  const n = Number(size);
  if (!(n > 0)) return 0;
  if (unit === "qty") return Number.isInteger(n) ? n : 0;
  return ask && ask > 0 ? Math.floor(n / ask + 1e-9) : 0;
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

function Confirm({
  text,
  onConfirm,
  onCancel,
}: {
  text: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="pos-confirm" role="group" aria-label="Confirm the order">
      <span>{text}</span>
      <button type="button" className="pos-go" onClick={onConfirm}>
        Confirm
      </button>
      <button type="button" className="pos-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function BuyTicket({ q }: { q: StockQuoteView }) {
  const [unit, setUnit] = useState<"qty" | "usd">("qty");
  const [size, setSize] = useState("1");
  const [run, setRun] = useState<Run>({ step: "idle" });
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const busy = run.step === "sending" || run.step === "working";
  const shares = buyShares(unit, size, q.ask ?? q.last);
  const cost = shares * (q.ask ?? q.last ?? 0);
  const body = {
    symbol: q.symbol,
    ...(unit === "qty" ? { qty: shares } : { amount: Number(size) }),
  };
  return (
    <section className="ticket" aria-label={`Buy ${q.symbol} shares`}>
      <h3>Buy {q.symbol}</h3>
      <div className="ticket-fields">
        <div className="ticket-field">
          <span id="stock-buy-size">Size</span>
          <div className="ticket-size">
            <input
              className="num"
              inputMode="decimal"
              aria-labelledby="stock-buy-size"
              value={size}
              disabled={busy}
              onChange={(e) => {
                setSize(e.target.value.replace(/[^\d.]/g, ""));
                setRun({ step: "idle" });
              }}
            />
            <div className="segmented" role="group" aria-label="Size unit">
              <button
                type="button"
                aria-pressed={unit === "qty"}
                disabled={busy}
                onClick={() => {
                  setUnit("qty");
                  setSize("1");
                }}
              >
                Shares
              </button>
              <button
                type="button"
                aria-pressed={unit === "usd"}
                disabled={busy}
                onClick={() => {
                  setUnit("usd");
                  setSize("1000");
                }}
              >
                Dollars
              </button>
            </div>
          </div>
        </div>
      </div>
      <p className="ticket-summary">
        {shares > 0 ? (
          <>
            <strong className="num">
              {shares} share{shares === 1 ? "" : "s"}
            </strong>{" "}
            from {money(q.buyPrice)} up to the ask {money(q.ask)}: about{" "}
            <strong className="num">{usd(cost)}</strong>.
          </>
        ) : (
          "No whole share at this size."
        )}
      </p>
      {run.step === "confirm" ? (
        <Confirm
          text={`Buy ${shares} ${q.symbol} for about ${usd(cost)}?`}
          onConfirm={() =>
            void followOrder(
              "/api/portfolio/control/stock/buy",
              body,
              true,
              setRun,
              alive,
            )
          }
          onCancel={() => setRun({ step: "idle" })}
        />
      ) : (
        <button
          type="button"
          className="pos-go"
          disabled={busy || shares < 1}
          onClick={() => setRun({ step: "confirm" })}
        >
          {busy ? "Working…" : `Buy ${shares || ""} ${q.symbol}`}
        </button>
      )}
      <RunStatus run={run} />
    </section>
  );
}

function SellTicket({ q }: { q: StockQuoteView }) {
  const [size, setSize] = useState<string>("all");
  const [run, setRun] = useState<Run>({ step: "idle" });
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const busy = run.step === "sending" || run.step === "working";
  const shares =
    size === "all"
      ? q.sellable
      : size === "half"
        ? Math.max(1, Math.floor(q.sellable / 2))
        : Number(size);
  const valid =
    q.sellable > 0 &&
    Number.isInteger(shares) &&
    shares >= 1 &&
    shares <= q.sellable;
  return (
    <section className="ticket" aria-label={`Sell ${q.symbol} shares`}>
      <h3>
        Sell {q.symbol}
        <span className="muted num">
          {q.held} held
          {q.avgEntryPrice !== null && ` @ ${money(q.avgEntryPrice)}`}
          {q.sellable < q.held && ` · ${q.sellable} free`}
        </span>
      </h3>
      <div className="ticket-fields">
        <div className="ticket-field">
          <span id="stock-sell-size">Shares</span>
          <div className="ticket-size">
            <input
              className="num"
              inputMode="numeric"
              aria-labelledby="stock-sell-size"
              value={size === "all" || size === "half" ? String(shares) : size}
              disabled={busy}
              onChange={(e) => {
                setSize(e.target.value.replace(/\D/g, ""));
                setRun({ step: "idle" });
              }}
            />
            <div className="segmented" role="group" aria-label="How many">
              {(["half", "all"] as const).map((k) => (
                <button
                  type="button"
                  key={k}
                  aria-pressed={size === k}
                  disabled={busy}
                  onClick={() => setSize(k)}
                >
                  {k === "all" ? "All" : "Half"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      {shares > q.sellable && (
        <p className="note-amber" role="status">
          Only {q.sellable} can be sold: a sale never goes short.
        </p>
      )}
      {run.step === "confirm" ? (
        <Confirm
          text={`Sell ${shares} ${q.symbol}, from ${money(q.sellPrice)} down to the bid ${money(q.bid)}?`}
          onConfirm={() =>
            void followOrder(
              "/api/portfolio/control/stock/sell",
              {
                symbol: q.symbol,
                qty: size === "all" || size === "half" ? size : shares,
              },
              false,
              setRun,
              alive,
            )
          }
          onCancel={() => setRun({ step: "idle" })}
        />
      ) : (
        <button
          type="button"
          className="pos-go"
          disabled={busy || !valid}
          onClick={() => setRun({ step: "confirm" })}
        >
          {busy ? "Working…" : `Sell ${valid ? shares : ""} ${q.symbol}`}
        </button>
      )}
      <RunStatus run={run} />
    </section>
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
        {q.marketOpen === false &&
          " · market closed: orders may fill in pre/after-hours"}
      </p>
      <p className="muted">
        Limit order from the mid, stepped toward the ask or bid. No size check
        and no automatic stop. What does not fill stays working for the day.
      </p>
      {q.openOrders.length > 0 && (
        <p className="note-amber" role="status">
          Working:{" "}
          {q.openOrders
            .map((o) => `${o.side} ${o.qty - o.filledQty} @ ${money(o.price)}`)
            .join(" · ")}
          . Open it from Orders to change or cancel it.
        </p>
      )}
      <BuyTicket key={`buy-${q.symbol}`} q={q} />
      {q.held > 0 && <SellTicket key={`sell-${q.symbol}`} q={q} />}
    </>
  );
}
