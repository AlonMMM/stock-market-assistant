import type {
  Contract,
  Portfolio as PortfolioData,
  PortfolioOrder,
  PortfolioPosition,
} from "../../../packages/trading/src/portfolio.js";
import { usePolling } from "./Live.js";
import { israelClock, israelDateTime, israelLabel } from "./time.js";

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

/** Live → Portfolio: the Alpaca account, its positions and working orders. */
export function Portfolio({ onError }: { onError: (m: string) => void }) {
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
