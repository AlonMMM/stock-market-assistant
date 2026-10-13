import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import type { TradeEngine } from "../../../packages/trading/src/engine.js";
import { readJson } from "./api.js";
import type {
  Portfolio,
  PortfolioOrder,
} from "../../../packages/trading/src/portfolio.js";
import { usePolling } from "./Live.js";
import { OrderActions, StopMover } from "./OrderControls.js";
import { followOrder, type Run } from "./order-run.js";
import { inTheMoney, priceRowIndex } from "./chain-model.js";
import { chartSession } from "./positions-model.js";
import { StockChart } from "./StockChart.js";

// The trade ticket (Portfolio → Trade, account owner only): the option chain
// of a stock, a strike picked from it, the order sized and checked, then
// sent. The trading service runs the same checks as for any other buy.

type Chain = Awaited<ReturnType<TradeEngine["chainFor"]>>;
type Check = Awaited<ReturnType<TradeEngine["checkContract"]>>;
type Quote = Chain["quotes"][number];
type Right = "call" | "put";

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const expiry = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "short",
  day: "numeric",
  month: "short",
});
const expiryLabel = (date: string) =>
  expiry.format(Date.parse(`${date}T00:00:00Z`));
const price = (n: number) => (n > 0 ? n.toFixed(2) : "—");
const quoteRefreshMs = 2000;
const clockSeconds = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function Ticket({ chain, quote }: { chain: Chain; quote: Quote }) {
  const [unit, setUnit] = useState<"pct" | "qty">("pct");
  const [size, setSize] = useState("0.5");
  const [stop, setStop] = useState("40");
  const [force, setForce] = useState(false);
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
  useEffect(() => {
    setCheck(null);
    setError("");
    setRun({ step: "idle" });
  }, [quote.contract, unit, size, stop, force]);

  const busy = run.step === "sending" || run.step === "working";
  const order = {
    contract: quote.contract,
    ...(unit === "pct" ? { sizePct: Number(size) } : { qty: Number(size) }),
    stopPct: Number(stop),
    ...(force ? { force: true } : {}),
  };
  const sizeOk =
    unit === "pct"
      ? Number(size) > 0
      : Number.isInteger(Number(size)) && Number(size) >= 1;
  const stopOk = Number(stop) > 0;

  async function runCheck(event: FormEvent) {
    event.preventDefault();
    setChecking(true);
    setError("");
    try {
      const result = await readJson<Check>(
        await fetch("/api/portfolio/control/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(order),
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
    followOrder("/api/portfolio/control/buy", order, true, setRun, alive);
  const name = `${chain.underlying} ${quote.strike} ${chain.right === "call" ? "Call" : "Put"} · ${expiryLabel(chain.expiry)}`;

  return (
    <form className="ticket" onSubmit={runCheck} aria-label={`Buy ${name}`}>
      <h3>
        Buy {name}
        <span className="muted num">
          bid {price(quote.bid)} · ask {price(quote.ask)}
        </span>
      </h3>
      <div className="ticket-fields">
        <div className="ticket-field">
          <span id="ticket-size">Size</span>
          <div className="ticket-size">
            <input
              className="num"
              inputMode="decimal"
              aria-labelledby="ticket-size"
              value={size}
              disabled={busy}
              onChange={(e) => setSize(e.target.value.replace(/[^\d.]/g, ""))}
            />
            <div className="segmented" role="group" aria-label="Size unit">
              <button
                type="button"
                aria-pressed={unit === "pct"}
                disabled={busy}
                onClick={() => {
                  setUnit("pct");
                  setSize("0.5");
                }}
              >
                % of account
              </button>
              <button
                type="button"
                aria-pressed={unit === "qty"}
                disabled={busy}
                onClick={() => {
                  setUnit("qty");
                  setSize("1");
                }}
              >
                Contracts
              </button>
            </div>
          </div>
        </div>
        <label className="ticket-field">
          <span>Stop, % below the price paid</span>
          <input
            className="num"
            inputMode="decimal"
            value={stop}
            disabled={busy}
            onChange={(e) => setStop(e.target.value.replace(/[^\d.]/g, ""))}
          />
        </label>
        <label className="ticket-force">
          <input
            type="checkbox"
            checked={force}
            disabled={busy}
            onChange={(e) => setForce(e.target.checked)}
          />
          <span>
            Force: buy whatever the spread is
            <span className="muted">
              {" "}
              (otherwise at most {chain.maxSpreadPct}% of the mid)
            </span>
          </span>
        </label>
      </div>
      {!check && (
        <button
          type="submit"
          className="pos-go"
          disabled={checking || !sizeOk || !stopOk}
        >
          {checking ? "Checking…" : "Check the order"}
        </button>
      )}
      {error && <p className="notice error">{error}</p>}
      {check && (
        <div className="ticket-check">
          <p className="ticket-summary">
            {check.qty > 0 ? (
              <>
                <strong className="num">
                  {check.qty} contract{check.qty === 1 ? "" : "s"}
                </strong>{" "}
                at up to {check.ceiling.toFixed(2)} each: at most{" "}
                <strong className="num">{usd(check.maxCost)}</strong>,{" "}
                {check.sizePct.toFixed(2)}% of the account.
                {check.stopAtCeiling !== null &&
                  ` Stop near ${check.stopAtCeiling.toFixed(2)}, set from the price paid.`}
              </>
            ) : (
              "No whole contract fits this size."
            )}
            {!check.marketOpen &&
              " The market is closed: the order would wait for the open."}
          </p>
          {check.notes.length > 0 && (
            <ul className="ticket-notes">
              {check.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <ul className="why-checks">
            {check.checks.map((c) => (
              <li key={c.check + c.detail} className={c.ok ? "ok" : "bad"}>
                <span aria-hidden="true">{c.ok ? "✓" : "✕"}</span>
                <strong>{c.check}</strong>
                <span className="muted">{c.detail}</span>
              </li>
            ))}
          </ul>
          {!check.wouldBuy ? (
            <p className="note-amber" role="status">
              This order would be refused. Change it and check again.
            </p>
          ) : run.step === "confirm" ? (
            <div
              className="pos-confirm"
              role="group"
              aria-label="Confirm the order"
            >
              <span>
                Buy {check.qty} {name} for at most {usd(check.maxCost)}
                {check.paper ? " on the paper account" : ""}?
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
                  : `Buy ${check.qty} contract${check.qty === 1 ? "" : "s"}`}
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
    </form>
  );
}

/** The stock's latest price, between the strikes around it. */
function PriceRow({ chain }: { chain: Chain }) {
  return (
    <tr className="chain-price" aria-label="Stock price">
      <td colSpan={5}>
        <span className="chain-price-tag num">
          {chain.underlying} {chain.underlyingPrice!.toFixed(2)}
        </span>
      </td>
    </tr>
  );
}

/** Pick a stock, see its options, choose a strike, check and buy. */
export function Trade({ edit }: { edit?: PortfolioOrder | null }) {
  const [ticker, setTicker] = useState(edit?.underlying ?? "");
  const [right, setRight] = useState<Right>(edit?.option?.right ?? "call");
  // The account as it is now: the order being edited, and its position.
  const account = usePolling<Portfolio>("/api/portfolio", 1000, () => {});
  const order = edit
    ? account.value?.orders.find((o) => o.id === edit.id)
    : undefined;
  const position = edit
    ? account.value?.positions.find((p) => p.symbol === edit.symbol)
    : undefined;
  const [chain, setChain] = useState<Chain | null>(null);
  // The first answer lists the expiries; later ones are for one of them.
  const [expiries, setExpiries] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const picked = useRef<HTMLTableRowElement>(null);

  // An order opened from the list: its stock, side, expiry and strike.
  useEffect(() => {
    if (!edit?.option) return;
    void load(
      edit.underlying,
      edit.option.right,
      edit.option.expiry,
      edit.symbol,
    );
  }, [edit?.id]);

  async function load(
    underlying: string,
    side: Right,
    date?: string,
    select?: string,
  ) {
    const id = ++request.current;
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({
        underlying,
        right: side,
        ...(date ? { expiry: date } : {}),
      });
      const next = await readJson<Chain>(
        await fetch(`/api/portfolio/control/chain?${query}`, {
          signal: AbortSignal.timeout(30000),
        }),
      );
      if (id !== request.current) return;
      setChain(next);
      if (next.expiries) setExpiries(next.expiries);
      setSelected(
        select && next.quotes.some((q) => q.contract === select)
          ? select
          : next.pick,
      );
    } catch (e) {
      if (id !== request.current) return;
      if (!date) {
        setChain(null);
        setExpiries([]);
      }
      setError(e instanceof Error ? e.message : "The options did not load");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }
  // Quotes move all the time: the open expiry is read again every two
  // seconds while the page is visible. The chosen strike stays chosen.
  const [quotedAt, setQuotedAt] = useState<number | null>(null);
  const [showChart, setShowChart] = useState(false);
  const shown = chain
    ? `${chain.underlying}/${chain.right}/${chain.expiry}`
    : "";
  useEffect(() => {
    if (!chain) return;
    const { underlying, right: side, expiry: date } = chain;
    setQuotedAt(Date.now());
    let live = true;
    let reading = false;
    const refresh = async () => {
      if (reading || document.visibilityState !== "visible") return;
      reading = true;
      const id = request.current;
      try {
        const query = new URLSearchParams({
          underlying,
          right: side,
          expiry: date,
        });
        const next = await readJson<Chain>(
          await fetch(`/api/portfolio/control/chain?${query}`, {
            signal: AbortSignal.timeout(10000),
          }),
        );
        // Dropped when another stock, side or expiry was asked for meanwhile.
        if (!live || id !== request.current) return;
        setChain(next);
        setQuotedAt(Date.now());
      } catch {
        // One missed refresh; the next one is two seconds away.
      } finally {
        reading = false;
      }
    };
    const timer = setInterval(refresh, quoteRefreshMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [shown]);

  // The strike a plain buy would take is brought into view.
  useEffect(() => {
    picked.current?.scrollIntoView({ block: "center" });
  }, [chain?.expiry, chain?.underlying, chain?.right]);

  const symbol = ticker.trim().toUpperCase();
  const quote = chain?.quotes.find((q) => q.contract === selected);
  const priceRow = chain
    ? priceRowIndex(
        chain.quotes.map((q) => q.strike),
        chain.underlyingPrice,
      )
    : null;
  return (
    <div className="portfolio trade">
      <form
        className="trade-find"
        onSubmit={(e) => {
          e.preventDefault();
          if (symbol) void load(symbol, right);
        }}
      >
        <label>
          <span>Stock</span>
          <input
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            placeholder="NVDA"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={6}
          />
        </label>
        <div className="segmented" role="group" aria-label="Call or put">
          {(["call", "put"] as const).map((side) => (
            <button
              type="button"
              key={side}
              aria-pressed={right === side}
              onClick={() => {
                setRight(side);
                if (chain && symbol === chain.underlying)
                  void load(symbol, side);
              }}
            >
              {side === "call" ? "Calls" : "Puts"}
            </button>
          ))}
        </div>
        <button type="submit" className="pos-go" disabled={!symbol || loading}>
          {loading ? "Loading…" : "Show options"}
        </button>
      </form>
      {error && <p className="notice error">{error}</p>}
      {!chain && !error && (
        <p className="notice">
          Enter a stock to see its options. Nothing is sent until you check an
          order and confirm it.
        </p>
      )}
      {chain && (
        <>
          <div className="trade-chart">
            <button
              type="button"
              className="pos-cancel"
              aria-expanded={showChart}
              onClick={() => setShowChart(!showChart)}
            >
              {showChart ? "Hide" : "Show"} the {chain.underlying} chart
            </button>
            {quotedAt !== null && (
              <span className="muted num" role="status">
                Quotes updated {clockSeconds.format(quotedAt)} Israel time
              </span>
            )}
          </div>
          {showChart && (
            <StockChart ticker={chain.underlying} date={chartSession()} />
          )}
          <div
            className="trade-expiries"
            role="group"
            aria-label={`${chain.underlying} expiry`}
          >
            {(expiries.length > 0 ? expiries : [chain.expiry]).map((date) => (
              <button
                type="button"
                key={date}
                aria-pressed={date === chain.expiry}
                onClick={() => void load(chain.underlying, chain.right, date)}
              >
                {expiryLabel(date)}
              </button>
            ))}
          </div>
          <div className={loading ? "chain loading" : "chain"}>
            <table>
              <caption className="sr-only">
                {chain.underlying} {chain.right}s expiring{" "}
                {expiryLabel(chain.expiry)}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Strike</th>
                  <th scope="col">Bid</th>
                  <th scope="col">Ask</th>
                  <th scope="col">Spread</th>
                  <th scope="col">Delta</th>
                </tr>
              </thead>
              <tbody>
                {chain.quotes.map((q, i) => {
                  const wide =
                    q.spreadPct === null || q.spreadPct > chain.maxSpreadPct;
                  return (
                    <Fragment key={q.contract}>
                      {i === priceRow && <PriceRow chain={chain} />}
                      <tr
                        ref={q.contract === chain.pick ? picked : undefined}
                        className={[
                          q.contract === selected ? "selected" : "",
                          q.ask > 0 ? "" : "dead",
                          inTheMoney(
                            chain.right,
                            q.strike,
                            chain.underlyingPrice,
                          )
                            ? "itm"
                            : "",
                        ].join(" ")}
                        onClick={() => setSelected(q.contract)}
                      >
                        <th scope="row">
                          <button
                            type="button"
                            aria-pressed={q.contract === selected}
                            onClick={() => setSelected(q.contract)}
                          >
                            <span className="num">{q.strike}</span>
                            {q.contract === chain.pick && (
                              <span className="chain-tag">default</span>
                            )}
                          </button>
                        </th>
                        <td className="num">{price(q.bid)}</td>
                        <td className="num">{price(q.ask)}</td>
                        <td className={wide ? "num wide" : "num"}>
                          {q.spreadPct === null
                            ? "—"
                            : `${q.spreadPct.toFixed(0)}%`}
                        </td>
                        <td className="num">
                          {q.delta === null ? "—" : q.delta.toFixed(2)}
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
                {priceRow === chain.quotes.length && <PriceRow chain={chain} />}
              </tbody>
            </table>
          </div>
          {edit && selected === edit.symbol && (
            <section className="ticket open-order" aria-label="Open order">
              <h3>
                {edit.stopPrice !== null ? "Stop" : "Open order"} on{" "}
                {chain.underlying} {quote?.strike}{" "}
                {chain.right === "call" ? "Call" : "Put"}
                {quote && (
                  <span className="muted num">
                    bid {price(quote.bid)} · ask {price(quote.ask)}
                  </span>
                )}
              </h3>
              {!account.value ? (
                <p className="chart-status">Loading the order…</p>
              ) : !order ? (
                <p className="note-amber" role="status">
                  This order is no longer open: it filled, was canceled or was
                  replaced. Live trades shows what is held now.
                </p>
              ) : (
                <>
                  <p className="ticket-summary num">
                    {order.side === "buy" ? "Buy" : "Sell"} {order.qty} ·{" "}
                    {order.stopPrice !== null
                      ? `stop ${order.stopPrice.toFixed(2)}`
                      : `limit ${order.limitPrice?.toFixed(2) ?? "—"}`}
                    {order.filledQty > 0 && ` · ${order.filledQty} filled`} ·{" "}
                    {order.status.replaceAll("_", " ")}
                  </p>
                  {order.stopPrice !== null && position && (
                    <StopMover p={position} />
                  )}
                  <OrderActions key={order.id} o={order} quote={quote} />
                </>
              )}
            </section>
          )}
          {edit && selected === edit.symbol && order ? null : quote ? (
            <Ticket key={quote.contract} chain={chain} quote={quote} />
          ) : (
            <p className="muted">Choose a strike to build the order.</p>
          )}
        </>
      )}
    </div>
  );
}
