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
import { usePolling } from "./Live.js";
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

function Position({ p }: { p: PortfolioPosition }) {
  const unit = p.option ? "contract" : "share";
  // How far the current price is above the stop, as a share of the price.
  const away =
    p.stop && p.price ? ((p.price - p.stop.price) / p.price) * 100 : null;
  return (
    <li className="position">
      <div className="position-head">
        <strong>{optionName(p)}</strong>
        <span className="muted">
          {p.option ? `${expiryLabel(p.option.expiry)} · ` : ""}
          {p.qty} {unit}
          {Math.abs(p.qty) === 1 ? "" : "s"}
        </span>
        <span className={`position-pnl num${tone(p.pnl)}`}>
          {p.pnl === null ? "—" : signedUsd(p.pnl)}
          {p.pnlPct !== null && ` (${signedPct(p.pnlPct)})`}
        </span>
      </div>
      <dl>
        <dt>Entry → now</dt>
        <dd className="num">
          {p.entry.toFixed(2)} → {p.price === null ? "—" : p.price.toFixed(2)}
        </dd>
        <dt>Value</dt>
        <dd className="num">
          {p.value === null ? "—" : usd(p.value)}
          {p.sharePct !== null && ` · ${p.sharePct.toFixed(1)}% of account`}
        </dd>
        <dt>Today</dt>
        <dd className={`num${tone(p.dayPnl)}`}>
          {p.dayPnl === null ? "—" : signedUsd(p.dayPnl)}
        </dd>
        <dt>Stop</dt>
        {p.stop ? (
          <dd className="num">
            {p.stop.price.toFixed(2)} (−{p.stop.lossPct.toFixed(0)}% from entry,{" "}
            {usd(p.stop.risk)} at risk)
            {away !== null &&
              (away > 0
                ? ` · ${away.toFixed(0)}% above the stop`
                : " · at or below the stop")}
            {p.stop.qty < p.qty && (
              <span className="stop-missing">
                Covers {p.stop.qty} of {p.qty}.
              </span>
            )}
          </dd>
        ) : (
          <dd className="stop-missing">No stop order</dd>
        )}
      </dl>
    </li>
  );
}

function Order({ o }: { o: PortfolioOrder }) {
  const price =
    o.stopPrice !== null
      ? `stop ${o.stopPrice.toFixed(2)}`
      : o.limitPrice !== null
        ? `limit ${o.limitPrice.toFixed(2)}`
        : o.type;
  return (
    <li>
      <strong>
        {optionName(o)}
        {o.option && ` · ${expiryLabel(o.option.expiry)}`}
      </strong>
      <span className="num">
        {o.side === "buy" ? "Buy" : "Sell"} {o.qty} · {price}
        {o.filledQty > 0 && ` · ${o.filledQty} filled`}
      </span>
      <span className="muted">
        {o.status.replaceAll("_", " ")}
        {o.submittedAt &&
          ` · ${israelDateTime(Date.parse(o.submittedAt))} ${israelLabel}`}
      </span>
    </li>
  );
}

function Trade({ t }: { t: ClosedTrade }) {
  const opened = israelDateTime(Date.parse(t.openedAt));
  // An expiry has a date but no time of day.
  const closed = t.expired ? "expiry" : israelDateTime(Date.parse(t.closedAt));
  return (
    <li className="position">
      <div className="position-head">
        <strong>{optionName(t)}</strong>
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
    </li>
  );
}

function History({ onError }: { onError: (m: string) => void }) {
  const [period, setPeriod] = useState<HistoryPeriod>("1M");
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
          {value.points.length > 1 ? (
            <Suspense fallback={<p className="chart-status">Loading chart…</p>}>
              <PnlChart points={value.points} />
            </Suspense>
          ) : (
            <p className="notice">Not enough account history for a chart.</p>
          )}
          <h2 className="portfolio-title">Closed trades</h2>
          {value.trades.length > 0 ? (
            <ul className="positions">
              {value.trades.map((t) => (
                <Trade key={t.symbol + t.closedAt} t={t} />
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

const sections = [
  ["live", "Live trades"],
  ["history", "History"],
] as const;

/** The Portfolio area: open trades, and the account's history. */
export function Portfolio({ modes }: { modes: ReactNode }) {
  const [tab, setTab] = useState<(typeof sections)[number][0]>("live");
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
          const next = tab === "live" ? "history" : "live";
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
            onClick={() => setTab(key)}
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
          <LiveTrades onError={ignore} />
        ) : (
          <History onError={ignore} />
        )}
      </section>
    </div>
  );
}

/** The Alpaca account now: totals, open positions and working orders. */
function LiveTrades({ onError }: { onError: (m: string) => void }) {
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
      <dl className="portfolio-totals">
        <div>
          <dt>Equity</dt>
          <dd className="num">{usd(account.equity)}</dd>
        </div>
        <div>
          <dt>Today</dt>
          <dd className={`num${tone(account.dayChange)}`}>
            {signedUsd(account.dayChange)}
            {account.dayChangePct !== null &&
              ` (${signedPct(account.dayChangePct)})`}
          </dd>
        </div>
        <div>
          <dt>Cash</dt>
          <dd className="num">{usd(account.cash)}</dd>
        </div>
        <div>
          <dt>At risk to stops</dt>
          <dd className="num">
            {usd(value.riskAtStops)}
            {account.equity > 0 &&
              ` (${((value.riskAtStops / account.equity) * 100).toFixed(1)}%)`}
          </dd>
        </div>
      </dl>
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
        <ul className="positions">
          {positions.map((p) => (
            <Position key={p.symbol} p={p} />
          ))}
        </ul>
      ) : (
        <p className="notice">No open positions.</p>
      )}
      <h2 className="portfolio-title">Open orders</h2>
      {orders.length > 0 ? (
        <ul className="portfolio-orders">
          {orders.map((o) => (
            <Order key={o.id} o={o} />
          ))}
        </ul>
      ) : (
        <p className="muted">No open orders.</p>
      )}
    </div>
  );
}
