import { lazy, Suspense, useEffect, useState } from "react";
import type { Board } from "../../../packages/market-data/src/board.js";
import type { TickerInfo } from "../../../packages/market-data/src/ticker.js";
import type { Portfolio } from "../../../packages/trading/src/portfolio.js";
import { readJson } from "./api.js";
import { useControlAccess } from "./Positions.js";
import type { FeedAlert } from "./AlertFeed.js";
import { usePolling } from "./Live.js";
import {
  alertDate,
  alertDirection,
  statsOf,
  watchRows,
  type NightPrices,
} from "./live-model.js";
import {
  BellIcon,
  PriceAlertList,
  PriceAlertSheet,
  usePriceAlerts,
} from "./PriceAlerts.js";
import { israelClock } from "./time.js";
import { scoreTone, toneWords } from "./vs-spy-model.js";
import { EarningsBadge } from "./EarningsBadge.js";

// One stock's own page (user 2026-10-18: "open the ticker with extra data in
// its own page, like IBKR"): its price and today's chart as the watchlist
// shows it, buttons to its options, shares and alerts, the day's and the
// year's numbers next to SPY, what is held of it, and its news.

const ChartPanel = lazy(() =>
  import("./ChartPanel.js").then((m) => ({ default: m.ChartPanel })),
);

const infoRefreshMs = 15000;
const price = (n: number | null | undefined) =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
const pct = (n: number | null | undefined) =>
  n == null ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
const shares = (n: number | null | undefined) =>
  n == null
    ? "—"
    : n >= 1e9
      ? `${(n / 1e9).toFixed(2)}B`
      : n >= 1e6
        ? `${(n / 1e6).toFixed(2)}M`
        : n >= 1e3
          ? `${(n / 1e3).toFixed(1)}K`
          : String(Math.round(n));
const usd = (n: number) =>
  `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const newsDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Where `value` sits between `low` and `high`, 0 to 1; null when unknown. */
function where(value: number | null | undefined, low?: number, high?: number) {
  if (value == null || low === undefined || high === undefined) return null;
  return high > low
    ? Math.min(1, Math.max(0, (value - low) / (high - low)))
    : 0.5;
}

function Range({
  label,
  low,
  high,
  at,
}: {
  label: string;
  low: number | undefined;
  high: number | undefined;
  at: number | null;
}) {
  return (
    <div className="tk-range">
      <span>{label}</span>
      <div className="tk-range-bar" aria-hidden="true">
        {at !== null && <i style={{ left: `${at * 100}%` }} />}
      </div>
      <span className="num tk-range-ends">
        <span>{price(low)}</span>
        <span>{price(high)}</span>
      </span>
    </div>
  );
}

/** The year's closes as a line; green when it ends above where it began. */
function YearLine({ closes }: { closes: [number, number][] }) {
  if (closes.length < 2) return null;
  const values = closes.map((c) => c[1]);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const w = 600;
  const h = 120;
  const points = values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 4 - ((v - lo) / (hi - lo || 1)) * (h - 8)).toFixed(1)}`,
    )
    .join(" ");
  const up = values.at(-1)! >= values[0]!;
  return (
    <svg
      className={`tk-year ${up ? "up" : "down"}`}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`One year of closes, from ${price(values[0])} to ${price(values.at(-1))}`}
    >
      <polyline points={points} />
    </svg>
  );
}

export function TickerPage({
  ticker,
  board,
  night,
  alerts,
  onBack,
  onTrade,
}: {
  ticker: string;
  board: Board | null;
  // The latest prints after the board's day (overnight, BOATS).
  night?: NightPrices;
  alerts: FeedAlert[];
  onBack: () => void;
  // Absent for visitors who cannot trade.
  onTrade?: ((mode: "options" | "stock") => void) | undefined;
}) {
  const [info, setInfo] = useState<TickerInfo | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const next = await readJson<TickerInfo>(
          await fetch(`/api/ticker?ticker=${encodeURIComponent(ticker)}`, {
            signal: AbortSignal.timeout(20000),
          }),
        );
        if (live) {
          setInfo(next);
          setError("");
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "Not loaded");
      }
    };
    void load();
    const timer = setInterval(load, infoRefreshMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [ticker]);
  // The user's own price alerts on it, apart from the volume alerts.
  const priceAlerts = usePriceAlerts(ticker);
  const { canTrade: canEdit } = useControlAccess();
  const mine = priceAlerts.alerts ?? [];
  const [sheet, setSheet] = useState(false);
  // What is held of it, and its open orders (any visitor sees the portfolio).
  const account = usePolling<Portfolio>("/api/portfolio", 10000, () => {});

  const row = board
    ? watchRows(board, new Map(), "SPY", {
        now: Date.now(),
        night: night ?? {},
      }).find((r) => r.ticker === ticker)
    : undefined;
  // Overnight (20:00–04:00 New York) a BOATS print leads, against the close.
  const nightRow = row?.mark === "night" ? row : null;
  const stats = statsOf(board?.series.find((s) => s.ticker === ticker));
  const today = alerts.filter(
    (a) => a.ticker === ticker && (!board || alertDate(a) === board.date),
  );
  const q = info?.quote;
  const last = nightRow ? nightRow.last : (q?.last ?? row?.last ?? null);
  const prev = q?.previousClose ?? row?.previousClose ?? null;
  const change = nightRow
    ? nightRow.changeUsd
    : last !== null && prev
      ? last - prev
      : null;
  const changePct = nightRow
    ? nightRow.change
    : change !== null && prev
      ? (change / prev) * 100
      : null;
  const s = info?.stats;
  const held = (account.value?.positions ?? []).filter(
    (p) => p.underlying === ticker,
  );
  const orders = (account.value?.orders ?? []).filter(
    (o) => o.underlying === ticker,
  );
  const sector = board?.benchmarks[ticker];

  return (
    <div className="tk">
      <button type="button" className="tk-back" onClick={onBack}>
        ‹ Watchlist
      </button>
      <section className="tk-head" aria-label={`${ticker} quote`}>
        <div className="tk-name">
          <h2>
            {ticker}
            <EarningsBadge symbol={ticker} />
          </h2>
          <p className="muted">
            {info?.asset?.name ?? (error ? "" : "Loading…")}
            {info?.asset?.exchange && ` · ${info.asset.exchange}`}
            {sector && ` · sector ${sector}`}
          </p>
        </div>
        <div className="tk-price">
          <strong className="num">{price(last)}</strong>
          {change !== null && (
            <span className={`num ${change >= 0 ? "up" : "down"}`}>
              {signed(change)} ({pct(changePct)})
            </span>
          )}
          <span className="muted num">
            {nightRow
              ? `Night · vs close · ${israelClock(night![ticker]!.at)}`
              : q?.bid != null && q.ask != null
                ? `${price(q.bid)} × ${price(q.ask)}`
                : ""}
            {!nightRow && q?.at ? ` · ${israelClock(q.at)}` : ""}
          </span>
        </div>
      </section>
      {error && !info && <p className="notice error">{error}</p>}

      <div className="tk-actions">
        {onTrade && (
          <>
            <button
              type="button"
              className="pos-go"
              disabled={info?.asset?.optionable === false}
              onClick={() => onTrade("options")}
            >
              Options
            </button>
            <button
              type="button"
              className="pos-go tk-alt"
              onClick={() => onTrade("stock")}
            >
              Shares
            </button>
          </>
        )}
        {canEdit && (
          <button
            type="button"
            className="pos-cancel tk-bell"
            onClick={() => setSheet(true)}
          >
            <BellIcon />
            Price alert
          </button>
        )}
      </div>
      {mine.length > 0 && (
        <section className="tk-card pa-mine" aria-label="Your price alerts">
          <h3>Your price alerts</h3>
          <PriceAlertList
            alerts={mine}
            api={priceAlerts}
            showTicker={false}
            canEdit={canEdit}
          />
        </section>
      )}
      {canEdit && sheet && (
        <PriceAlertSheet
          ticker={ticker}
          last={last}
          previousClose={prev}
          api={priceAlerts}
          onClose={() => setSheet(false)}
        />
      )}

      <section className="tk-card tk-chart" aria-label={`${ticker} today`}>
        {board ? (
          <Suspense fallback={<p className="chart-status">Loading chart…</p>}>
            <ChartPanel
              ticker={ticker}
              date={board.date}
              sector={board.benchmarks[ticker]}
            />
          </Suspense>
        ) : (
          <p className="chart-status">Loading chart…</p>
        )}
      </section>

      <div className="tk-grid">
        <section className="tk-card" aria-label="Today">
          <h3>Today</h3>
          <dl className="tk-stats num">
            <div>
              <dt>Open</dt>
              <dd>{price(q?.open)}</dd>
            </div>
            <div>
              <dt>Prev close</dt>
              <dd>{price(prev)}</dd>
            </div>
            <div>
              <dt>Volume</dt>
              <dd>{shares(q?.volume ?? row?.volume)}</dd>
            </div>
            <div>
              <dt>Avg vol (30d)</dt>
              <dd>{shares(s?.avgVolume30)}</dd>
            </div>
            <div>
              <dt>Rel vol</dt>
              <dd>
                {row?.relVolume == null ? "—" : `${row.relVolume.toFixed(1)}×`}
              </dd>
            </div>
            <div>
              <dt>VWAP</dt>
              <dd>{price(q?.vwap)}</dd>
            </div>
            <div>
              <dt>Beta</dt>
              <dd>{stats?.beta == null ? "—" : stats.beta.toFixed(2)}</dd>
            </div>
            <div>
              <dt>Score vs SPY</dt>
              <dd>
                {row?.rsScore == null
                  ? "—"
                  : `${row.rsScore} · ${toneWords[scoreTone(row.rsScore)]}`}
              </dd>
            </div>
          </dl>
          <Range
            label="Day range"
            low={q?.low ?? row?.dayLow ?? undefined}
            high={q?.high ?? row?.dayHigh ?? undefined}
            at={where(
              last,
              q?.low ?? row?.dayLow ?? undefined,
              q?.high ?? row?.dayHigh ?? undefined,
            )}
          />
          <Range
            label="52-week range"
            low={s?.yearLow}
            high={s?.yearHigh}
            at={where(last, s?.yearLow, s?.yearHigh)}
          />
        </section>

        <section className="tk-card" aria-label="Performance">
          <h3>Performance vs SPY</h3>
          {s ? (
            <>
              <YearLine closes={s.closes} />
              <div className="tk-perf-box">
                <table className="tk-perf num">
                  <thead>
                    <tr>
                      <th scope="col" />
                      {s.returns.map((r) => (
                        <th scope="col" key={r.period}>
                          {r.period}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">{ticker}</th>
                      {s.returns.map((r) => (
                        <td
                          key={r.period}
                          className={
                            r.stock === null ? "" : r.stock >= 0 ? "up" : "down"
                          }
                        >
                          {pct(r.stock)}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th scope="row">SPY</th>
                      {s.returns.map((r) => (
                        <td key={r.period} className="muted">
                          {pct(r.spy)}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="chart-status">{info ? "No history." : "Loading…"}</p>
          )}
        </section>

        {(held.length > 0 || orders.length > 0) && (
          <section className="tk-card" aria-label="Your position">
            <h3>Your position</h3>
            <ul className="tk-list num">
              {held.map((p) => (
                <li key={p.symbol}>
                  <span>
                    {p.option
                      ? `${p.qty} × ${p.option.strike} ${p.option.right === "call" ? "Call" : "Put"} ${p.option.expiry}`
                      : `${p.qty} shares`}
                    <small className="muted">
                      {" "}
                      @ {price(p.entry)}
                      {p.stop ? ` · stop ${price(p.stop.price)}` : " · no stop"}
                    </small>
                  </span>
                  {p.pnl !== null && (
                    <b className={p.pnl >= 0 ? "up" : "down"}>
                      {usd(p.pnl)} {pct(p.pnlPct)}
                    </b>
                  )}
                </li>
              ))}
              {orders.map((o) => (
                <li key={o.id}>
                  <span>
                    {o.side === "buy" ? "Buy" : "Sell"} {o.qty - o.filledQty}{" "}
                    {o.option
                      ? `${o.option.strike} ${o.option.right === "call" ? "Call" : "Put"}`
                      : "shares"}{" "}
                    · {o.type.replaceAll("_", " ")}
                    {o.stopPrice !== null && ` stop ${price(o.stopPrice)}`}
                    {o.limitPrice !== null && ` limit ${price(o.limitPrice)}`}
                  </span>
                  <small className="muted">
                    {o.status.replaceAll("_", " ")}
                  </small>
                </li>
              ))}
            </ul>
          </section>
        )}

        {today.length > 0 && (
          <section className="tk-card" aria-label="Volume alerts today">
            <h3>Volume alerts today</h3>
            <ul className="tk-list num">
              {today.map((a) => (
                <li key={a.end}>
                  <span>
                    {israelClock(Date.parse(a.end))} ·{" "}
                    {alertDirection(a) === "up" ? "▲" : "▼"} {pct(a.move)}
                  </span>
                  <small className="muted">
                    {a.ratio === null ? "—" : `${a.ratio.toFixed(1)}×`} volume
                  </small>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="tk-card tk-news" aria-label="News">
          <h3>News</h3>
          {info && info.news.length === 0 && (
            <p className="muted">No recent news.</p>
          )}
          <ul>
            {(info?.news ?? []).map((n) => (
              <li key={n.url}>
                <a href={n.url} target="_blank" rel="noopener noreferrer">
                  {n.headline}
                </a>
                <small className="muted">
                  {n.source && `${n.source} · `}
                  {n.at ? newsDate.format(n.at) : ""}
                </small>
              </li>
            ))}
          </ul>
        </section>

        {info?.asset && (
          <section className="tk-card" aria-label="About">
            <h3>About</h3>
            <dl className="tk-stats">
              <div>
                <dt>Name</dt>
                <dd>{info.asset.name}</dd>
              </div>
              <div>
                <dt>Exchange</dt>
                <dd>{info.asset.exchange || "—"}</dd>
              </div>
              <div>
                <dt>Options</dt>
                <dd>
                  {info.asset.optionable === null
                    ? "—"
                    : info.asset.optionable
                      ? "Listed"
                      : "None"}
                </dd>
              </div>
              <div>
                <dt>Tradable</dt>
                <dd>{info.asset.tradable ? "Yes" : "No"}</dd>
              </div>
            </dl>
          </section>
        )}
      </div>
    </div>
  );
}
