import { lazy, Suspense, useState, type ReactNode } from "react";
import type {
  ClosedTrade,
  Contract,
  HistoryPeriod,
  Portfolio as PortfolioData,
  PortfolioHistory,
  PortfolioOrder,
  PortfolioPosition,
} from "../../../packages/trading/src/portfolio.js";
import type { Decision } from "../../../packages/trading/src/explain.js";
import { usePolling } from "./Live.js";
import { OrderActions, StopMover } from "./OrderControls.js";
import { BotChip, BotPanel, useBotContracts } from "./BotPanel.js";
import { Orders, useDecisions, WhyButton } from "./Orders.js";
import { PositionList, useControlAccess } from "./Positions.js";
import { positionNumbers } from "./positions-model.js";
import { Trade as TradeTicket } from "./Trade.js";
import { israelClock, israelDateTime, israelLabel } from "./time.js";

const PnlChart = lazy(() =>
  import("./PnlChart.js").then((m) => ({ default: m.PnlChart })),
);
// Daily points and closed trades; the API keeps them for a minute.
const historyRefreshMs = 60000;
const periods: [HistoryPeriod, string][] = [
  ["1W", "Week"],
  ["1M", "Month"],
  ["3M", "3 months"],
  ["1A", "Year"],
];

// The API reuses Alpaca's answers briefly (portfolioTtlMs), so open orders
// and the stops read from them can be up to five seconds old.
const refreshMs = 1000;

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

const optionName = (c: Contract) =>
  c.option
    ? `${c.underlying} ${c.option.strike} ${c.option.right === "call" ? "Call" : "Put"}`
    : c.symbol;

function Order({
  o,
  why,
  onEdit,
  position,
}: {
  o: PortfolioOrder;
  why?: Decision | undefined;
  // Opens the order on the Trade page; absent for visitors who cannot trade.
  onEdit?: ((o: PortfolioOrder) => void) | undefined;
  // The position a stop protects: the stop is moved here, in place (user
  // 2026-10-19: "move stop should open in the same window").
  position?: PortfolioPosition | undefined;
}) {
  const [open, setOpen] = useState(false);
  const price =
    o.stopPrice !== null
      ? `stop ${o.stopPrice.toFixed(2)}`
      : o.limitPrice !== null
        ? `limit ${o.limitPrice.toFixed(2)}`
        : o.type;
  const editable = onEdit !== undefined;
  return (
    <li
      className={editable ? `order-row${open ? " open" : ""}` : undefined}
      onClick={editable ? () => setOpen(!open) : undefined}
    >
      <strong>
        {optionName(o)}
        {o.option && ` · ${expiryLabel(o.option.expiry)}`}
      </strong>
      {onEdit && (
        <button
          type="button"
          className="why-button order-open"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(o);
          }}
        >
          Open in Trade
        </button>
      )}
      <span className="num">
        {o.side === "buy" ? "Buy" : "Sell"} {o.qty} · {price}
        {o.filledQty > 0 && ` · ${o.filledQty} filled`}
      </span>
      <span className="muted">
        {o.status.replaceAll("_", " ")}
        {o.submittedAt &&
          ` · ${israelDateTime(Date.parse(o.submittedAt))} ${israelLabel}`}
      </span>
      {why && o.side === "buy" && <WhyButton decision={why} />}
      {editable && open && (
        <div className="order-inline" onClick={(e) => e.stopPropagation()}>
          {o.stopPrice !== null && position ? <StopMover p={position} /> : null}
          <OrderActions o={o} />
        </div>
      )}
    </li>
  );
}

function Trade({ t, bot }: { t: ClosedTrade; bot: boolean }) {
  const opened = israelDateTime(Date.parse(t.openedAt));
  // An expiry has a date but no time of day.
  const closed = t.expired ? "expiry" : israelDateTime(Date.parse(t.closedAt));
  // A tap shows each buy, sale and expiry (user 2026-10-19).
  const [open, setOpen] = useState(false);
  const multiplier = t.option ? 100 : 1;
  const fills = t.fills ?? [];
  return (
    <li className={`position trade-row${open ? " open" : ""}`}>
      <button
        type="button"
        className="trade-toggle"
        aria-expanded={open}
        disabled={fills.length === 0}
        onClick={() => setOpen(!open)}
      >
        <div className="position-head">
          <strong>{optionName(t)}</strong>
          {bot && <BotChip />}
          <span className="muted">
            {t.option ? `${expiryLabel(t.option.expiry)} · ` : ""}
            {t.qty} {t.option ? "contract" : "share"}
            {t.qty === 1 ? "" : "s"}
          </span>
          <span className={`position-pnl num${tone(t.pnl)}`}>
            {signedUsd(t.pnl)}
            {t.pnlPct !== null && ` (${signedPct(t.pnlPct)})`}
          </span>
        </div>
        <dl>
          <dt>Bought → sold</dt>
          <dd className="num">
            {t.entry.toFixed(2)} → {t.expired ? "expired" : t.exit.toFixed(2)}
          </dd>
          <dt>Held</dt>
          <dd>
            {opened} → {closed} · {israelLabel}
          </dd>
        </dl>
        {fills.length > 0 && (
          <span className="trade-more muted" aria-hidden="true">
            {open ? "Hide the fills ▴" : `${fills.length} fills ▾`}
          </span>
        )}
      </button>
      {open && (
        <table className="trade-fills num">
          <thead>
            <tr>
              <th scope="col">When ({israelLabel})</th>
              <th scope="col">Side</th>
              <th scope="col">Qty</th>
              <th scope="col">Price</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {fills.map((f, i) => (
              <tr key={i} className={f.side}>
                <td>
                  {f.side === "expired"
                    ? f.at.slice(0, 10)
                    : israelDateTime(Date.parse(f.at))}
                </td>
                <td>
                  {f.side === "buy"
                    ? "Buy"
                    : f.side === "sell"
                      ? "Sell"
                      : "Expired"}
                </td>
                <td>{f.qty}</td>
                <td>{f.side === "expired" ? "—" : f.price.toFixed(2)}</td>
                <td>
                  {f.side === "buy" ? "−" : "+"}
                  {usd(f.qty * f.price * multiplier)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={4}>
                Result
              </th>
              <td className={tone(t.pnl).trim()}>{signedUsd(t.pnl)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </li>
  );
}

function History({ onError }: { onError: (m: string) => void }) {
  const [period, setPeriod] = useState<HistoryPeriod>("1M");
  const bot = useBotContracts();
  const { value, error } = usePolling<PortfolioHistory>(
    `/api/portfolio/history?period=${period}`,
    historyRefreshMs,
    onError,
  );
  // While another period loads, the previous one stays on screen.
  const stale = value !== null && value.period !== period;
  const label = periods.find(([key]) => key === period)![1].toLowerCase();
  return (
    <div className="portfolio">
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Period">
          {periods.map(([key, text]) => (
            <button
              type="button"
              key={key}
              aria-pressed={period === key}
              onClick={() => setPeriod(key)}
            >
              {text}
            </button>
          ))}
        </div>
        {value && (
          <span className={value.paper ? "account-tag paper" : "account-tag"}>
            {value.paper ? "Paper account" : "Live account"}
          </span>
        )}
      </div>
      {!value ? (
        <p className={error ? "notice error" : "chart-status"}>
          {error ? `History unavailable: ${error}` : "Loading history…"}
        </p>
      ) : (
        <div className={stale ? "portfolio loading" : "portfolio"}>
          {error && <p className="note-amber">Update failed: {error}</p>}
          <dl className="portfolio-totals">
            <div>
              <dt>Profit and loss, {stale ? "…" : label}</dt>
              <dd className={`num${tone(value.pnl)}`}>
                {signedUsd(value.pnl)}
                {value.pnlPct !== null && ` (${signedPct(value.pnlPct)})`}
              </dd>
            </div>
            <div>
              <dt>Closed trades</dt>
              <dd className="num">
                {value.trades.length}
                {value.trades.length > 0 && ` · ${value.wins} won`}
              </dd>
            </div>
            <div>
              <dt>Realized on closed trades</dt>
              <dd className={`num${tone(value.realized)}`}>
                {signedUsd(value.realized)}
              </dd>
            </div>
          </dl>
          {value.trades.length > 0 ? (
            <Suspense fallback={<p className="chart-status">Loading chart…</p>}>
              <PnlChart key={value.period} history={value} />
            </Suspense>
          ) : (
            <p className="notice">No closed trades to plot in this period.</p>
          )}
          <h2 className="portfolio-title">Closed trades</h2>
          {value.trades.length > 0 ? (
            <ul className="positions">
              {value.trades.map((t) => (
                <Trade
                  key={t.symbol + t.closedAt}
                  t={t}
                  bot={bot.has(t.symbol)}
                />
              ))}
            </ul>
          ) : (
            <p className="notice">No trades were closed in this period.</p>
          )}
          {value.truncated && (
            <p className="muted">
              Built from the account&apos;s latest {value.activityLimit} fills;
              older trades may be missing.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const allSections = [
  ["live", "Live trades"],
  ["trade", "Trade"],
  ["orders", "Orders"],
  ["history", "History"],
  ["bot", "🤖 Bot"],
] as const;

/** The Portfolio area: open trades, and the account's history. */
export function Portfolio({
  modes,
  tradeSymbol = null,
  tradeMode = "options",
}: {
  modes: ReactNode;
  // A stock picked elsewhere (the watchlist): the trade ticket opens on it,
  // on its options or its shares.
  tradeSymbol?: string | null;
  tradeMode?: "options" | "stock";
}) {
  const [tab, setTab] = useState<(typeof allSections)[number][0]>(
    tradeSymbol ? "trade" : "live",
  );
  // The trade ticket is for the account owner only.
  const { canTrade } = useControlAccess();
  // The open order the Trade page was opened on, if any.
  const [editing, setEditing] = useState<PortfolioOrder | null>(null);
  const sections = allSections.filter(([key]) => key !== "trade" || canTrade);
  const ignore = () => {}; // failures are shown in place
  return (
    <div className="live-page">
      <header>
        <div className="brand-status">
          <span className="brand">
            SMA<span className="brand-dot">.</span>
          </span>
        </div>
        {modes}
      </header>
      <div
        role="tablist"
        aria-label="Portfolio sections"
        className="tabs"
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          const at = sections.findIndex(([key]) => key === tab);
          const step = e.key === "ArrowRight" ? 1 : sections.length - 1;
          const next = sections[(at + step) % sections.length]![0];
          setTab(next);
          document.getElementById(`tab-${next}`)?.focus();
        }}
      >
        {sections.map(([key, label]) => (
          <button
            type="button"
            role="tab"
            key={key}
            id={`tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`panel-${key}`}
            tabIndex={tab === key ? 0 : -1}
            onClick={() => {
              // The tab itself starts a new ticket, not the last order.
              setEditing(null);
              setTab(key);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        className="tab-panel"
      >
        {tab === "live" ? (
          <LiveTrades
            onError={ignore}
            onEdit={(o) => {
              setEditing(o);
              setTab("trade");
            }}
          />
        ) : tab === "trade" && canTrade ? (
          <TradeTicket
            key={editing?.id ?? "new"}
            edit={editing}
            ticker={editing ? undefined : (tradeSymbol ?? undefined)}
            startMode={tradeMode}
          />
        ) : tab === "orders" ? (
          <Orders onError={ignore} />
        ) : tab === "bot" ? (
          <BotPanel />
        ) : (
          <History onError={ignore} />
        )}
      </section>
    </div>
  );
}

/** The Alpaca account now: totals, open positions and working orders. */
function LiveTrades({
  onError,
  onEdit,
}: {
  onError: (m: string) => void;
  onEdit: (o: PortfolioOrder) => void;
}) {
  // The reasons behind each order; the page works without them.
  const why = useDecisions(() => {});
  const bot = useBotContracts();
  const { canTrade } = useControlAccess();
  const [accountView, setAccountView] = useState<"close" | "overnight">(
    "close",
  );
  const { value, at, error } = usePolling<PortfolioData>(
    "/api/portfolio",
    refreshMs,
    onError,
  );
  if (!value)
    return (
      <p className={error ? "notice error" : "chart-status"}>
        {error ? `Portfolio unavailable: ${error}` : "Loading portfolio…"}
      </p>
    );
  const { account, positions, orders } = value;
  const useOvernight = value.marketClosed && accountView === "overnight";
  const selectedView = useOvernight ? "overnight" : "close";
  const displayEquity =
    useOvernight && value.overnightEstimate?.equity !== null
      ? (value.overnightEstimate?.equity ?? account.equity)
      : account.equity;
  const openPnlValues = positions.map(
    (p) => positionNumbers(p, selectedView, displayEquity).pnl,
  );
  const openPnl = openPnlValues.reduce<number>(
    (sum, pnl) => sum + (pnl ?? 0),
    0,
  );
  return (
    <div className="portfolio">
      <p className="portfolio-meta">
        <span className={value.paper ? "account-tag paper" : "account-tag"}>
          {value.paper ? "Paper account" : "Live account"}
        </span>
        <span className="muted">
          {error
            ? `Update failed (${error}). Showing ${israelClock(Date.parse(value.at))} ${israelLabel}.`
            : `Updated ${israelClock(at ?? Date.parse(value.at))} ${israelLabel}`}
        </span>
      </p>
      <div className="account">
        {value.marketClosed && (
          <div className="account-view-row">
            <span className="account-view-label">Show values</span>
            <div
              className="segmented small account-view-toggle"
              role="group"
              aria-label="Portfolio value view"
            >
              <button
                type="button"
                aria-pressed={!useOvernight}
                onClick={() => setAccountView("close")}
              >
                Close
              </button>
              <button
                type="button"
                aria-pressed={useOvernight}
                onClick={() => setAccountView("overnight")}
              >
                Approx. now
              </button>
            </div>
          </div>
        )}
        <div className="account-main">
          <span className="account-label">
            {useOvernight
              ? "Approx. account value"
              : value.marketClosed
                ? "Account value at close"
                : "Net liquidation"}
          </span>
          <strong className="num">
            {useOvernight
              ? value.overnightEstimate?.equity === null ||
                value.overnightEstimate?.equity === undefined
                ? "—"
                : `~${usd(value.overnightEstimate.equity)}`
              : usd(account.equity)}
          </strong>
          {useOvernight ? (
            value.overnightEstimate?.change !== null &&
            value.overnightEstimate?.change !== undefined && (
              <span
                className={`num account-day${tone(value.overnightEstimate.change)}`}
              >
                {signedUsd(value.overnightEstimate.change)} vs close
              </span>
            )
          ) : (
            <span className={`num account-day${tone(account.dayChange)}`}>
              {signedUsd(account.dayChange)}
              {account.dayChangePct !== null &&
                ` (${signedPct(account.dayChangePct)})`}{" "}
              US session
            </span>
          )}
        </div>
        <dl className="account-stats">
          <div>
            <dt>{useOvernight ? "Approx. open P&L" : "Open P&L"}</dt>
            <dd className={`num${tone(openPnl)}`}>{signedUsd(openPnl)}</dd>
            {useOvernight &&
              value.overnightEstimate &&
              value.overnightEstimate.pricedPositions <
                value.overnightEstimate.totalPositions && (
                <small className="account-view-note">
                  {value.overnightEstimate.pricedPositions}/
                  {value.overnightEstimate.totalPositions} priced
                </small>
              )}
          </div>
          <div>
            <dt>Cash</dt>
            <dd className="num">{usd(account.cash)}</dd>
          </div>
          <div>
            <dt>At risk to stops</dt>
            <dd className="num">
              {usd(value.riskAtStops)}
              {displayEquity > 0 &&
                ` (${((value.riskAtStops / displayEquity) * 100).toFixed(1)}%)`}
            </dd>
          </div>
        </dl>
      </div>
      {value.shortRisks.length > 0 && (
        <div className="notice error short-alert" role="alert">
          <strong>Short option risk. This must never happen.</strong>
          <ul>
            {value.shortRisks.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {value.unprotected > 0 && (
        <p className="note-amber" role="status">
          {value.unprotected === 1
            ? "1 position is"
            : `${value.unprotected} positions are`}{" "}
          not fully covered by a stop order.
        </p>
      )}
      <h2 className="portfolio-title">Positions</h2>
      {positions.length > 0 ? (
        <PositionList
          positions={positions}
          why={why}
          view={selectedView}
          equity={displayEquity}
          bot={bot}
        />
      ) : (
        <p className="notice">No open positions.</p>
      )}
      <h2 className="portfolio-title">Open orders</h2>
      {orders.length > 0 ? (
        <ul className="portfolio-orders">
          {orders.map((o) => (
            <Order
              key={o.id}
              o={o}
              why={why.get(o.symbol)}
              onEdit={canTrade ? onEdit : undefined}
              position={positions.find((p) => p.symbol === o.symbol)}
            />
          ))}
        </ul>
      ) : (
        <p className="muted">No open orders.</p>
      )}
    </div>
  );
}
