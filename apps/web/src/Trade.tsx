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
import {
  daysLabel,
  daysToExpiry,
  expiryTab,
  inTheMoney,
  isMonthly,
  pairStrikes,
  priceRowIndex,
} from "./chain-model.js";
import { chartSession } from "./positions-model.js";
import { StockChart } from "./StockChart.js";
import { OptionTicket } from "./OptionTicket.js";
import { StockTrade } from "./StockTrade.js";

// The trade ticket (Portfolio → Trade, account owner only): the option chain
// of a stock, calls and puts side by side around the strikes (as in IBKR), a
// contract picked from it, the order sized and checked, then sent. The
// trading service runs the same checks as for any other buy.

type Chain = Awaited<ReturnType<TradeEngine["chainFor"]>>;
type Check = Awaited<ReturnType<TradeEngine["checkContract"]>>;
type SpreadCheck = Awaited<ReturnType<TradeEngine["checkSpreadOrder"]>>;
type Quote = Chain["quotes"][number];
type Right = "call" | "put";
// Both sides of one expiry; a side is null when it did not load.
type Sides = Record<Right, Chain | null>;
const rights = ["call", "put"] as const;
const rightName = (r: Right) => (r === "call" ? "Call" : "Put");

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
const contracts = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
// Options trade in $0.01 below $3 and $0.05 from $3.
const toTick = (n: number) => {
  const t = n < 3 ? 0.01 : 0.05;
  return (Math.floor(n / t + 1e-9) * t).toFixed(2);
};
const onTick = (n: number) => Number(toTick(n)) === n;
const quoteRefreshMs = 2000;
const clockSeconds = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

// A phone (user 2026-10-18): one side of the chain at a time, every column
// in view, and the order in a sheet over the bottom of the screen.
const narrowQuery = "(max-width: 720px)";
function useNarrow() {
  const [narrow, setNarrow] = useState(
    () => typeof matchMedia === "function" && matchMedia(narrowQuery).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(narrowQuery);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** Whether buying `buy` and selling `sell` is a debit spread (user 2026-10-17). */
const isDebit = (right: Right, buy: number, sell: number) =>
  right === "call" ? buy < sell : buy > sell;

/** A two-leg debit spread: sized, priced, checked, then sent as one order. */
function SpreadTicket({
  chain,
  buy,
  sell,
}: {
  chain: Chain;
  buy: Quote;
  sell: Quote;
}) {
  const mid = (buy.bid + buy.ask - sell.bid - sell.ask) / 2;
  const natural = buy.ask - sell.bid;
  const [unit, setUnit] = useState<"pct" | "qty">("pct");
  const [size, setSize] = useState("0.5");
  const [limit, setLimit] = useState(() =>
    Math.max(Math.round(mid * 100) / 100, 0.01).toFixed(2),
  );
  const [check, setCheck] = useState<SpreadCheck | null>(null);
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
  useEffect(() => {
    setCheck(null);
    setError("");
    setRun({ step: "idle" });
  }, [unit, size, limit]);

  const busy = run.step === "sending" || run.step === "working";
  const order = {
    long: buy.contract,
    short: sell.contract,
    ...(unit === "pct" ? { sizePct: Number(size) } : { qty: Number(size) }),
    limitPrice: Number(limit),
  };
  const width = Math.abs(buy.strike - sell.strike);
  const sizeOk =
    unit === "pct"
      ? Number(size) > 0
      : Number.isInteger(Number(size)) && Number(size) >= 1;
  const limitOk = Number(limit) > 0 && Number(limit) < width;
  const kind = rightName(chain.right);
  const name = `${chain.underlying} ${buy.strike}/${sell.strike} ${kind} spread · ${expiryLabel(chain.expiry)}`;

  async function runCheck(event: FormEvent) {
    event.preventDefault();
    setChecking(true);
    setError("");
    try {
      const result = await readJson<SpreadCheck>(
        await fetch("/api/portfolio/control/spread/check", {
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

  if (!isDebit(chain.right, buy.strike, sell.strike))
    return (
      <p className="note-amber" role="status">
        Buying {buy.strike} and selling {sell.strike} would be a credit spread.
        Only debit spreads are allowed: sell a strike{" "}
        {chain.right === "call" ? "above" : "below"} the one you buy.
      </p>
    );
  return (
    <form className="ticket" onSubmit={runCheck} aria-label={`Buy ${name}`}>
      <h3>
        Buy {name}
        <span className="muted num">
          net mid {mid.toFixed(2)} · natural {natural.toFixed(2)}
        </span>
      </h3>
      <p className="spread-legs num">
        <span>
          <span className="leg-tag buy">Buy</span>
          {buy.strike} {kind} at the ask {price(buy.ask)}
        </span>
        <span>
          <span className="leg-tag sell">Sell</span>
          {sell.strike} {kind} at the bid {price(sell.bid)}
        </span>
      </p>
      <div className="ticket-fields">
        <div className="ticket-field">
          <span id="spread-size">Size</span>
          <div className="ticket-size">
            <input
              className="num"
              inputMode="decimal"
              aria-labelledby="spread-size"
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
                % at risk
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
                Spreads
              </button>
            </div>
          </div>
        </div>
        <label className="ticket-field">
          <span>Net debit, limit per spread</span>
          <input
            className="num"
            inputMode="decimal"
            value={limit}
            disabled={busy}
            onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ""))}
          />
          <span className="muted ticket-hint">
            {limitOk
              ? `A day order. The most it can lose is what you pay; it has no stop. The spread is ${width} wide.`
              : `Above 0 and below the ${width} width of the spread.`}
          </span>
        </label>
      </div>
      {!check && (
        <button
          type="submit"
          className="pos-go"
          disabled={checking || !sizeOk || !limitOk}
        >
          {checking ? "Checking…" : "Check the spread"}
        </button>
      )}
      {error && <p className="notice error">{error}</p>}
      {check && (
        <div className="ticket-check">
          <p className="ticket-summary">
            {check.qty > 0 ? (
              <>
                <strong className="num">
                  {check.qty} spread{check.qty === 1 ? "" : "s"}
                </strong>{" "}
                at a net {check.limitPrice.toFixed(2)}: at most{" "}
                <strong className="num">{usd(check.maxLoss)}</strong> lost,{" "}
                {usd(check.maxGain)} gained if {chain.underlying} ends{" "}
                {chain.right === "call" ? "above" : "below"} {sell.strike}.
                Breakeven {check.breakeven.toFixed(2)}.
              </>
            ) : (
              "No whole spread fits this size."
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
              This spread would be refused. Change it and check again.
            </p>
          ) : run.step === "confirm" ? (
            <div
              className="pos-confirm"
              role="group"
              aria-label="Confirm the spread"
            >
              <span>
                Buy {check.qty} {name} for at most {usd(check.maxLoss)}
                {check.paper ? " on the paper account" : ""}?
              </span>
              <button
                type="button"
                className="pos-go"
                onClick={() =>
                  void followOrder(
                    "/api/portfolio/control/spread/buy",
                    order,
                    true,
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
            run.step !== "ended" && (
              <button
                type="button"
                className="pos-go"
                disabled={busy}
                onClick={() => setRun({ step: "confirm" })}
              >
                {busy
                  ? "Working…"
                  : `Buy ${check.qty} spread${check.qty === 1 ? "" : "s"}`}
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
function PriceRow({
  underlying,
  price,
  span = callColumns.length + 1 + putColumns.length,
}: {
  underlying: string;
  price: number;
  span?: number;
}) {
  return (
    <tr className="chain-price" aria-label="Stock price">
      <td colSpan={span}>
        <span className="chain-price-tag num">
          {underlying} {price.toFixed(2)}
        </span>
      </td>
    </tr>
  );
}

// Columns of each side, outermost first for calls and last for puts: the
// prices next to the strike, as in IBKR. A phone scrolls the table sideways.
const callColumns = ["oi", "iv", "spread", "delta", "bid", "ask"] as const;
const putColumns = ["bid", "ask", "delta", "spread", "iv", "oi"] as const;
// A phone shows one side, next to the strike, with every column in view.
const phoneColumns = ["bid", "ask", "delta", "iv", "oi"] as const;
const columnName = {
  oi: "OI",
  iv: "IV",
  spread: "Spread",
  delta: "Delta",
  bid: "Bid",
  ask: "Ask",
};
const columnTitle: Partial<Record<keyof typeof columnName, string>> = {
  oi: "Open interest: contracts open at the last count",
  iv: "Implied volatility",
};

/**
 * One side of a strike. A click anywhere on it picks the contract; the ask
 * is the button for the keyboard.
 */
function SideCells({
  right,
  chain,
  q,
  stockPrice,
  selected,
  legOf,
  onPick,
  only,
}: {
  // The columns to show, in this order (a phone); else the side's own.
  only?: readonly (keyof typeof columnName)[];
  right: Right;
  chain: Chain | null;
  q: Quote | null;
  stockPrice: number | null;
  selected: string | null;
  // Building a spread: which leg this contract is, if any.
  legOf?: (contract: string) => "buy" | "sell" | null;
  onPick: (contract: string) => void;
}) {
  const columns = only ?? (right === "call" ? callColumns : putColumns);
  if (!chain || !q)
    return (
      <>
        {columns.map((c) => (
          <td key={c} className={`c-${c}`} />
        ))}
      </>
    );
  const wide = q.spreadPct === null || q.spreadPct > chain.maxSpreadPct;
  const leg = legOf?.(q.contract) ?? null;
  const picked = leg !== null || q.contract === selected;
  const cls = [
    "side",
    right,
    "num",
    picked ? "selected" : "",
    leg ? `leg-${leg}` : "",
    q.ask > 0 ? "" : "dead",
    inTheMoney(right, q.strike, stockPrice) ? "itm" : "",
  ].join(" ");
  const pick = () => onPick(q.contract);
  // `== null`: a trading service from before these fields omits them.
  const cells = {
    oi: (
      <td key="oi" className={`${cls} c-oi`} onClick={pick}>
        {q.openInterest == null ? "—" : contracts.format(q.openInterest)}
      </td>
    ),
    iv: (
      <td key="iv" className={`${cls} c-iv`} onClick={pick}>
        {q.iv == null ? "—" : `${(q.iv * 100).toFixed(1)}%`}
      </td>
    ),
    spread: (
      <td
        key="spread"
        className={`${cls} c-spread${wide ? " wide" : ""}`}
        onClick={pick}
      >
        {q.spreadPct === null ? "—" : `${q.spreadPct.toFixed(0)}%`}
      </td>
    ),
    delta: (
      <td key="delta" className={`${cls} c-delta`} onClick={pick}>
        {q.contract === chain.pick && (
          <span className="chain-dot" title="Default strike for a plain buy" />
        )}
        {q.delta === null ? "—" : q.delta.toFixed(2)}
      </td>
    ),
    bid: (
      <td key="bid" className={`${cls} c-bid`} onClick={pick}>
        {price(q.bid)}
      </td>
    ),
    ask: (
      <td key="ask" className={`${cls} c-ask${wide ? " wide" : ""}`}>
        <button
          type="button"
          aria-pressed={picked}
          aria-label={`${q.strike} ${rightName(right)}: bid ${price(q.bid)}, ask ${price(q.ask)}${leg ? `, the leg to ${leg}` : ""}`}
          onClick={pick}
        >
          {leg && (
            <span className={`leg-tag ${leg}`} aria-hidden="true">
              {leg === "buy" ? "B" : "S"}
            </span>
          )}
          {price(q.ask)}
        </button>
      </td>
    ),
  };
  return <>{columns.map((c) => cells[c])}</>;
}

/** Pick a stock, see its options, choose a strike, check and buy. */
export function Trade({
  edit,
  ticker: startTicker,
}: {
  edit?: PortfolioOrder | null;
  // Opens on this stock's options (from the watchlist).
  ticker?: string | undefined;
}) {
  const [ticker, setTicker] = useState(edit?.underlying ?? startTicker ?? "");
  // The side the chain opens on: its default strike is chosen and in view.
  const right: Right = edit?.option?.right ?? "call";
  // Options, or the stock itself (shares).
  const [mode, setMode] = useState<"options" | "stock">(
    edit && !edit.option ? "stock" : "options",
  );
  const [stockShown, setStockShown] = useState<string | null>(
    edit && !edit.option ? edit.symbol : null,
  );
  // The account as it is now: the order being edited, and its position.
  const account = usePolling<Portfolio>("/api/portfolio", 1000, () => {});
  const order = edit
    ? account.value?.orders.find((o) => o.id === edit.id)
    : undefined;
  const position = edit
    ? account.value?.positions.find((p) => p.symbol === edit.symbol)
    : undefined;
  const [sides, setSides] = useState<Sides | null>(null);
  // The first answer lists the expiries; later ones are for one of them.
  const [expiries, setExpiries] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // One contract, or a two-leg debit spread picked leg by leg.
  const [strategy, setStrategy] = useState<"single" | "spread">("single");
  const [legs, setLegs] = useState<{ buy?: string; sell?: string }>({});
  const expiryBar = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  // One side that did not load while the other did.
  const [sideError, setSideError] = useState("");
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const picked = useRef<HTMLTableRowElement>(null);
  const chainBox = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();
  // A phone: the side in view, and whether the order sheet is open.
  const [phoneSide, setPhoneSide] = useState<Right>(right);
  const [sheetOpen, setSheetOpen] = useState(false);

  // A stock picked in the watchlist: show its options at once.
  useEffect(() => {
    if (!edit && startTicker) void load(startTicker.toUpperCase());
  }, []);

  // An order opened from the list: its stock, expiry and contract.
  useEffect(() => {
    if (!edit?.option) return;
    void load(edit.underlying, edit.option.expiry, edit.symbol);
  }, [edit?.id]);

  const readSide = async (
    underlying: string,
    side: Right,
    date: string | undefined,
    timeoutMs: number,
  ) => {
    const query = new URLSearchParams({
      underlying,
      right: side,
      ...(date ? { expiry: date } : {}),
    });
    return readJson<Chain>(
      await fetch(`/api/portfolio/control/chain?${query}`, {
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
  };

  // Calls and puts read together; one may fail while the other loads.
  const readBoth = (
    underlying: string,
    date: string | undefined,
    timeoutMs: number,
  ) =>
    Promise.allSettled([
      readSide(underlying, "call", date, timeoutMs),
      readSide(underlying, "put", date, timeoutMs),
    ]);

  /** Both sides of one expiry; without one, the nearest and the list. */
  async function load(underlying: string, date?: string, select?: string) {
    const id = ++request.current;
    setLoading(true);
    setError("");
    try {
      let [calls, puts] = await readBoth(underlying, date, 30000);
      // Each side picks its own nearest expiry: the puts follow the calls.
      if (
        !date &&
        calls.status === "fulfilled" &&
        puts.status === "fulfilled" &&
        puts.value.expiry !== calls.value.expiry
      )
        [puts] = await Promise.allSettled([
          readSide(underlying, "put", calls.value.expiry, 30000),
        ]);
      if (id !== request.current) return;
      if (calls.status === "rejected" && puts.status === "rejected")
        throw calls.reason;
      const next: Sides = {
        call: calls.status === "fulfilled" ? calls.value : null,
        put: puts.status === "fulfilled" ? puts.value : null,
      };
      const failed =
        calls.status === "rejected"
          ? { side: "Calls", reason: calls.reason as unknown }
          : puts.status === "rejected"
            ? { side: "Puts", reason: puts.reason as unknown }
            : null;
      setSideError(
        failed
          ? `${failed.side} did not load: ${failed.reason instanceof Error ? failed.reason.message : "unknown error"}`
          : "",
      );
      setSides(next);
      if (!date)
        setExpiries(
          [
            ...new Set([
              ...(next.call?.expiries ?? []),
              ...(next.put?.expiries ?? []),
            ]),
          ].sort(),
        );
      const listed = (contract: string) =>
        rights.some((side) =>
          next[side]?.quotes.some((q) => q.contract === contract),
        );
      setSelected(
        select && listed(select)
          ? select
          : (next[right]?.pick ?? next.call?.pick ?? next.put?.pick ?? null),
      );
    } catch (e) {
      if (id !== request.current) return;
      if (!date) {
        setSides(null);
        setExpiries([]);
      }
      setError(e instanceof Error ? e.message : "The options did not load");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }
  // Either side: the stock, expiry and price are the same on both.
  const base = sides ? (sides.call ?? sides.put) : null;
  // Quotes move all the time: the open expiry is read again every two
  // seconds while the page is visible. The chosen contract stays chosen.
  const [quotedAt, setQuotedAt] = useState<number | null>(null);
  const [showChart, setShowChart] = useState(false);
  const shown = base ? `${base.underlying}/${base.expiry}` : "";
  useEffect(() => {
    if (!base) return;
    const { underlying, expiry: date } = base;
    setQuotedAt(Date.now());
    let live = true;
    let reading = false;
    const refresh = async () => {
      if (reading || document.visibilityState !== "visible") return;
      reading = true;
      const id = request.current;
      try {
        const [calls, puts] = await readBoth(underlying, date, 10000);
        // Dropped when another stock or expiry was asked for meanwhile.
        if (!live || id !== request.current) return;
        // A side that misses one refresh keeps its last quotes.
        if (calls.status === "rejected" && puts.status === "rejected") return;
        setSides((prev) => ({
          call: calls.status === "fulfilled" ? calls.value : prev!.call,
          put: puts.status === "fulfilled" ? puts.value : prev!.put,
        }));
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

  // The strike a plain buy would take is brought into view; spread legs
  // belong to one stock and expiry.
  // Only the table scrolls, not the page: the strike column to the middle,
  // and the stock's price to the middle of the table's height (user
  // 2026-10-18); without a price, the strike a plain buy would take.
  useEffect(() => {
    const box = chainBox.current;
    const strike = box?.querySelector<HTMLElement>("thead th.strike");
    if (box && strike)
      box.scrollLeft =
        strike.offsetLeft + strike.offsetWidth / 2 - box.clientWidth / 2;
    const row =
      box?.querySelector<HTMLElement>("tr.chain-price") ?? picked.current;
    if (box && row)
      box.scrollTop =
        row.offsetTop + row.offsetHeight / 2 - box.clientHeight / 2;
    setLegs({});
  }, [shown]);
  // The chosen expiry tab is kept in view in its scrolling row.
  useEffect(() => {
    expiryBar.current
      ?.querySelector('[aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [shown, expiries.length]);

  const symbol = ticker.trim().toUpperCase();
  // The chosen contract and the side it is on.
  const side = rights.find((r) =>
    sides?.[r]?.quotes.some((q) => q.contract === selected),
  );
  const chain = side ? sides![side] : null;
  const quote = chain?.quotes.find((q) => q.contract === selected);
  // `?? null`: a trading service from before the field omits it.
  const stockPrice = base?.underlyingPrice ?? null;
  const rows = sides
    ? pairStrikes(sides.call?.quotes ?? [], sides.put?.quotes ?? [])
    : [];
  const priceRow = priceRowIndex(
    rows.map((r) => r.strike),
    stockPrice,
  );
  const scrollTo = (sides?.[right] ?? base)?.pick;
  const sideOf = (contract: string) =>
    rights.find((r) => sides?.[r]?.quotes.some((q) => q.contract === contract));
  const quoteOf = (contract: string | undefined) =>
    contract === undefined
      ? undefined
      : rights
          .map((r) => sides?.[r]?.quotes.find((q) => q.contract === contract))
          .find((q) => q !== undefined);
  /**
   * A tap on a contract: in a spread, the first is the leg to buy and the
   * next one on the same side the leg to sell; a third starts again.
   */
  const pickContract = (contract: string) => {
    if (strategy === "single") {
      setSheetOpen(true);
      return setSelected(contract);
    }
    setLegs((prev) =>
      !prev.buy || prev.sell
        ? { buy: contract }
        : prev.buy === contract
          ? {}
          : sideOf(prev.buy) !== sideOf(contract)
            ? { buy: contract }
            : { buy: prev.buy, sell: contract },
    );
  };
  const legOf =
    strategy === "spread"
      ? (c: string) =>
          c === legs.buy
            ? ("buy" as const)
            : c === legs.sell
              ? ("sell" as const)
              : null
      : null;
  const buyLeg = quoteOf(legs.buy);
  const sellLeg = quoteOf(legs.sell);
  const legSide = legs.buy ? sideOf(legs.buy) : undefined;
  const shiftExpiries = (dir: -1 | 1) =>
    expiryBar.current?.scrollBy({
      left: dir * expiryBar.current.clientWidth * 0.8,
      behavior: "smooth",
    });
  const maxSpread = base?.maxSpreadPct;
  return (
    <div className="portfolio trade">
      <form
        className="trade-find"
        onSubmit={(e) => {
          e.preventDefault();
          if (!symbol) return;
          if (mode === "stock") setStockShown(symbol);
          else void load(symbol);
        }}
      >
        <div className="segmented" role="group" aria-label="Options or shares">
          {(["options", "stock"] as const).map((m) => (
            <button
              type="button"
              key={m}
              aria-pressed={mode === m}
              onClick={() => {
                setMode(m);
                if (m === "stock" && symbol) setStockShown(symbol);
              }}
            >
              {m === "options" ? "Options" : "Shares"}
            </button>
          ))}
        </div>
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
        <button type="submit" className="pos-go" disabled={!symbol || loading}>
          {narrow
            ? loading
              ? "…"
              : "Show"
            : mode === "stock"
              ? "Show stock"
              : loading
                ? "Loading…"
                : "Show options"}
        </button>
      </form>
      {mode === "stock" && edit && !edit.option && (
        <section className="ticket open-order" aria-label="Open order">
          <h3>Open order on {edit.symbol}</h3>
          {!account.value ? (
            <p className="chart-status">Loading the order…</p>
          ) : !order ? (
            <p className="note-amber" role="status">
              This order is no longer open: it filled, was canceled or was
              replaced.
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
              <OrderActions key={order.id} o={order} />
            </>
          )}
        </section>
      )}
      {mode === "stock" &&
        (stockShown ? (
          <StockTrade symbol={stockShown} />
        ) : (
          <p className="notice">
            Enter a stock to buy or sell its shares. Nothing is sent until you
            confirm.
          </p>
        ))}
      {mode === "options" && (
        <>
          {error && <p className="notice error">{error}</p>}
          {!base && !error && (
            <p className="notice">
              Enter a stock to see its options. Nothing is sent until you check
              an order and confirm it.
            </p>
          )}
          {base && (
            <>
              <div className="trade-chart">
                <button
                  type="button"
                  className="pos-cancel"
                  aria-expanded={showChart}
                  onClick={() => setShowChart(!showChart)}
                >
                  {showChart ? "Hide" : "Show"} the {base.underlying} chart
                </button>
                {quotedAt !== null && (
                  <span className="muted num" role="status">
                    Quotes updated {clockSeconds.format(quotedAt)} Israel time
                  </span>
                )}
              </div>
              {showChart && (
                <StockChart ticker={base.underlying} date={chartSession()} />
              )}
              <div className="trade-grid">
                <div className="trade-main">
                  <div className="expiry-strip">
                    <button
                      type="button"
                      className="expiry-shift"
                      aria-label="Earlier expiries"
                      onClick={() => shiftExpiries(-1)}
                    >
                      ‹
                    </button>
                    <div
                      className="trade-expiries"
                      role="group"
                      aria-label={`${base.underlying} expiry`}
                      ref={expiryBar}
                    >
                      {(expiries.length > 0 ? expiries : [base.expiry]).map(
                        (date) => (
                          <button
                            type="button"
                            key={date}
                            aria-pressed={date === base.expiry}
                            aria-label={`${expiryLabel(date)}, ${isMonthly(date) ? "monthly" : "weekly"}, ${daysLabel(daysToExpiry(date, Date.now()))}`}
                            onClick={() => void load(base.underlying, date)}
                          >
                            <span className="expiry-date num">
                              {expiryTab(date)}
                              {!isMonthly(date) && <sup>W</sup>}
                            </span>
                            <span className="expiry-days">
                              {daysLabel(daysToExpiry(date, Date.now()))}
                            </span>
                          </button>
                        ),
                      )}
                    </div>
                    <button
                      type="button"
                      className="expiry-shift"
                      aria-label="Later expiries"
                      onClick={() => shiftExpiries(1)}
                    >
                      ›
                    </button>
                  </div>
                  <div className="chain-bar">
                    {narrow && (
                      <div
                        className="segmented"
                        role="group"
                        aria-label="Calls or puts"
                      >
                        {rights.map((r) => (
                          <button
                            type="button"
                            key={r}
                            aria-pressed={phoneSide === r}
                            onClick={() => setPhoneSide(r)}
                          >
                            {r === "call" ? "Calls" : "Puts"}
                          </button>
                        ))}
                      </div>
                    )}
                    <div
                      className="segmented"
                      role="group"
                      aria-label="One contract or a spread"
                    >
                      {(["single", "spread"] as const).map((k) => (
                        <button
                          type="button"
                          key={k}
                          aria-pressed={strategy === k}
                          disabled={!!edit}
                          onClick={() => {
                            setStrategy(k);
                            setLegs({});
                          }}
                        >
                          {k === "single" ? "Single" : "Spread"}
                        </button>
                      ))}
                    </div>
                    {strategy === "spread" && (
                      <span className="muted" role="status">
                        {!legs.buy
                          ? "Tap the contract to buy."
                          : !legs.sell
                            ? `Now tap the ${legSide === "put" ? "put" : "call"} to sell.`
                            : "Tap a contract to start again."}
                      </span>
                    )}
                  </div>
                  {sideError && <p className="notice error">{sideError}</p>}
                  <div
                    ref={chainBox}
                    className={loading ? "chain loading" : "chain"}
                  >
                    {narrow ? (
                      <table className={`chain-one ${phoneSide}`}>
                        <caption className="sr-only">
                          {base.underlying} {phoneSide}s expiring{" "}
                          {expiryLabel(base.expiry)}
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col" className="strike">
                              Strike
                            </th>
                            {phoneColumns.map((c) => (
                              <th
                                scope="col"
                                key={c}
                                className={`c-${c}`}
                                title={columnTitle[c]}
                              >
                                {columnName[c]}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <Fragment key={r.strike}>
                              {i === priceRow && (
                                <PriceRow
                                  underlying={base.underlying}
                                  price={stockPrice!}
                                  span={phoneColumns.length + 1}
                                />
                              )}
                              <tr
                                ref={
                                  scrollTo &&
                                  r[phoneSide]?.contract === scrollTo
                                    ? picked
                                    : undefined
                                }
                                className={
                                  strategy === "single" &&
                                  selected &&
                                  r[phoneSide]?.contract === selected
                                    ? "selected"
                                    : ""
                                }
                              >
                                <th scope="row" className="strike num">
                                  {r.strike}
                                </th>
                                <SideCells
                                  right={phoneSide}
                                  chain={sides![phoneSide]}
                                  q={r[phoneSide]}
                                  stockPrice={stockPrice}
                                  selected={
                                    strategy === "single" ? selected : null
                                  }
                                  {...(legOf ? { legOf } : {})}
                                  onPick={pickContract}
                                  only={phoneColumns}
                                />
                              </tr>
                            </Fragment>
                          ))}
                          {priceRow === rows.length && (
                            <PriceRow
                              underlying={base.underlying}
                              price={stockPrice!}
                              span={phoneColumns.length + 1}
                            />
                          )}
                        </tbody>
                      </table>
                    ) : (
                      <table>
                        <caption className="sr-only">
                          {base.underlying} calls and puts expiring{" "}
                          {expiryLabel(base.expiry)}
                        </caption>
                        <thead>
                          <tr className="chain-sides">
                            <th scope="colgroup" colSpan={callColumns.length}>
                              Calls
                            </th>
                            <th className="strike" />
                            <th scope="colgroup" colSpan={putColumns.length}>
                              Puts
                            </th>
                          </tr>
                          <tr>
                            {callColumns.map((c) => (
                              <th
                                scope="col"
                                key={c}
                                className={`c-${c}`}
                                title={columnTitle[c]}
                              >
                                {columnName[c]}
                              </th>
                            ))}
                            <th scope="col" className="strike">
                              Strike
                            </th>
                            {putColumns.map((c) => (
                              <th
                                scope="col"
                                key={c}
                                className={`c-${c}`}
                                title={columnTitle[c]}
                              >
                                {columnName[c]}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <Fragment key={r.strike}>
                              {i === priceRow && (
                                <PriceRow
                                  underlying={base.underlying}
                                  price={stockPrice!}
                                />
                              )}
                              <tr
                                ref={
                                  scrollTo &&
                                  (r.call?.contract === scrollTo ||
                                    r.put?.contract === scrollTo)
                                    ? picked
                                    : undefined
                                }
                                className={
                                  strategy === "single" &&
                                  selected &&
                                  (r.call?.contract === selected ||
                                    r.put?.contract === selected)
                                    ? "selected"
                                    : ""
                                }
                              >
                                <SideCells
                                  right="call"
                                  chain={sides!.call}
                                  q={r.call}
                                  stockPrice={stockPrice}
                                  selected={
                                    strategy === "single" ? selected : null
                                  }
                                  {...(legOf ? { legOf } : {})}
                                  onPick={pickContract}
                                />
                                <th scope="row" className="strike num">
                                  {r.strike}
                                </th>
                                <SideCells
                                  right="put"
                                  chain={sides!.put}
                                  q={r.put}
                                  stockPrice={stockPrice}
                                  selected={
                                    strategy === "single" ? selected : null
                                  }
                                  {...(legOf ? { legOf } : {})}
                                  onPick={pickContract}
                                />
                              </tr>
                            </Fragment>
                          ))}
                          {priceRow === rows.length && (
                            <PriceRow
                              underlying={base.underlying}
                              price={stockPrice!}
                            />
                          )}
                        </tbody>
                      </table>
                    )}
                  </div>
                  <p className="chain-legend muted">
                    {strategy === "single"
                      ? "Tap a call or a put to build its order."
                      : "B: the leg bought, S: the leg sold."}{" "}
                    Shaded: in the money. OI: open interest.{" "}
                    <span className="chain-dot" aria-hidden="true" /> default
                    strike for a buy without one. Amber: spread over {maxSpread}
                    % of the mid.
                  </p>
                  {strategy === "spread" &&
                    (legSide && buyLeg && sellLeg && sides?.[legSide] ? (
                      <SpreadTicket
                        key={`${buyLeg.contract}/${sellLeg.contract}`}
                        chain={sides[legSide]!}
                        buy={buyLeg}
                        sell={sellLeg}
                      />
                    ) : (
                      <p className="muted">
                        A spread buys one contract and sells another of the same
                        side and expiry. The most it can lose is the net price
                        paid.
                      </p>
                    ))}
                  {strategy === "single" &&
                    edit &&
                    chain &&
                    selected === edit.symbol && (
                      <section
                        className="ticket open-order"
                        aria-label="Open order"
                      >
                        <h3>
                          {edit.stopPrice !== null ? "Stop" : "Open order"} on{" "}
                          {chain.underlying} {quote?.strike}{" "}
                          {rightName(chain.right)}
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
                            This order is no longer open: it filled, was
                            canceled or was replaced. Live trades shows what is
                            held now.
                          </p>
                        ) : (
                          <>
                            <p className="ticket-summary num">
                              {order.side === "buy" ? "Buy" : "Sell"}{" "}
                              {order.qty} ·{" "}
                              {order.stopPrice !== null
                                ? `stop ${order.stopPrice.toFixed(2)}`
                                : `limit ${order.limitPrice?.toFixed(2) ?? "—"}`}
                              {order.filledQty > 0 &&
                                ` · ${order.filledQty} filled`}{" "}
                              · {order.status.replaceAll("_", " ")}
                            </p>
                            {order.stopPrice !== null && position && (
                              <StopMover p={position} />
                            )}
                            <OrderActions
                              key={order.id}
                              o={order}
                              quote={quote}
                            />
                          </>
                        )}
                      </section>
                    )}
                </div>
                {strategy === "spread" ? null : edit &&
                  selected === edit.symbol &&
                  order ? null : chain && quote ? (
                  <aside className="trade-side">
                    <OptionTicket
                      key={quote.contract}
                      chain={chain}
                      quote={quote}
                      name={`${chain.underlying} ${quote.strike} ${rightName(chain.right)} · ${expiryLabel(chain.expiry)}`}
                      {...(narrow
                        ? {
                            sheet: {
                              open: sheetOpen,
                              toggle: () => setSheetOpen(!sheetOpen),
                            },
                          }
                        : {})}
                    />
                  </aside>
                ) : (
                  <p className="muted">
                    Choose a call or a put to build the order.
                  </p>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
