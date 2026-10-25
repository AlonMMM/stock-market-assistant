import { lazy, Suspense, useState, type ReactNode } from "react";
import type React from "react";
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
import {
  botBrokers,
  brokerNames,
  type BotBroker,
} from "../../../packages/trading/src/bot/settings.js";
import { usePolling } from "./Live.js";
import { OrderActions, StopMover } from "./OrderControls.js";
import { BotChip, BotPanel, useBotContracts } from "./BotPanel.js";
import { BotSettingsPage } from "./BotSettings.js";
import { StrangleActivity, StrangleSettingsPage } from "./StranglePanel.js";
import { Orders, useDecisions, WhyButton } from "./Orders.js";
import { PositionList, useControlAccess } from "./Positions.js";
import {
  expiryLabel,
  optionName,
  signedPct,
  signedUsd,
  tone,
  usd,
} from "./format.js";
import { positionNumbers } from "./positions-model.js";
import { Trade as TradeTicket } from "./Trade.js";
import { israelClock, israelDateTime, israelLabel } from "./time.js";

const PnlChart = lazy(() =>
  import("./PnlChart.js").then((m) => ({ default: m.PnlChart })),
);
const TradeStory = lazy(() =>
  import("./TradeStory.js").then((m) => ({ default: m.TradeStory })),
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
  // A tap opens the trade's story: the chart, why it was entered and exited,
  // and each fill (user 2026-10-19 and 2026-10-24).
  const [open, setOpen] = useState(false);
  return (
    <li className={`position trade-row${open ? " open" : ""}`}>
      <button
        type="button"
        className="trade-toggle"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
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
        <span className="trade-more muted" aria-hidden="true">
          Chart, why in, why out ▸
        </span>
      </button>
      {open && (
        <Suspense fallback={null}>
          <TradeStory t={t} bot={bot} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </li>
  );
}

function History({
  onError,
  base = "/api/portfolio",
  chips = true,
  query = "",
}: {
  onError: (m: string) => void;
  // The account: the owner's, or the bot's own (/api/portfolio/bot).
  base?: string;
  // The Bot chip on the bot's trades; off when the whole account is the bot's.
  chips?: boolean;
  // More query parameters, e.g. the bot account's broker.
  query?: string;
}) {
  const [period, setPeriod] = useState<HistoryPeriod>("1M");
  const bot = useBotContracts();
  const { value, error } = usePolling<PortfolioHistory>(
    `${base}/history?period=${period}${query ? `&${query}` : ""}`,
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
                  bot={!chips || bot.has(t.symbol)}
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

// Two tabs, Trade and Bot, each with its own row of pages (user 2026-10-25:
// "this is too messy. lets go with 2 tabs, Trade and Bot under each all the
// related stuff"). Each tab remembers the page it was on.
const groups = [
  [
    "trade",
    "Trade",
    [
      ["live", "Live trades"],
      ["new", "New trade"],
      ["orders", "Orders"],
      ["history", "History"],
    ],
  ],
  [
    "bot",
    "🤖 Bot",
    [
      ["activity", "Activity"],
      ["trades", "Trades"],
      ["settings", "Settings"],
    ],
  ],
  // The alert strangle, a separate bot on its own paper account
  // (docs/tasks/backend-strangle-bot.md, user 2026-10-25: "not mix them").
  [
    "strangle",
    "🎯 Alert leg",
    [
      ["s-activity", "Activity"],
      ["s-trades", "Trades"],
      ["s-settings", "Settings"],
    ],
  ],
] as const;
type Group = (typeof groups)[number][0];
type Page = (typeof groups)[number][2][number][0];
// Pages for the account owner only: the trade ticket and the bot's settings.
const ownerPages: readonly Page[] = ["new", "settings", "s-settings"];

/** Arrow keys move along a tab row and focus the tab they land on. */
function arrowTo<K extends string>(
  e: React.KeyboardEvent,
  keys: readonly K[],
  current: K,
  go: (next: K) => void,
  idOf: (key: K) => string,
) {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const at = keys.indexOf(current);
  const step = e.key === "ArrowRight" ? 1 : keys.length - 1;
  const next = keys[(at + step) % keys.length]!;
  go(next);
  document.getElementById(idOf(next))?.focus();
}

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
  const [group, setGroup] = useState<Group>("trade");
  const [pages, setPages] = useState<Record<Group, Page>>({
    trade: tradeSymbol ? "new" : "live",
    bot: "activity",
    strangle: "s-activity",
  });
  // The trade ticket and the bot's settings are for the account owner only.
  const { canTrade } = useControlAccess();
  // The open order the Trade page was opened on, if any.
  const [editing, setEditing] = useState<PortfolioOrder | null>(null);
  const ignore = () => {}; // failures are shown in place
  const [, groupLabel, allPages] = groups.find(([key]) => key === group)!;
  const visible = allPages.filter(
    ([key]) => canTrade || !ownerPages.includes(key),
  );
  const wanted = pages[group];
  const page = visible.some(([key]) => key === wanted)
    ? wanted
    : visible[0]![0];
  const open = (g: Group, p: Page) => {
    setGroup(g);
    setPages((prev) => ({ ...prev, [g]: p }));
  };
  const panel = () => {
    if (page === "live")
      return (
        <LiveTrades
          onError={ignore}
          onEdit={(o) => {
            setEditing(o);
            open("trade", "new");
          }}
        />
      );
    if (page === "new" && canTrade)
      return (
        <TradeTicket
          key={editing?.id ?? "new"}
          edit={editing}
          ticker={editing ? undefined : (tradeSymbol ?? undefined)}
          startMode={tradeMode}
        />
      );
    if (page === "orders") return <Orders onError={ignore} />;
    if (page === "history") return <History onError={ignore} />;
    if (page === "activity")
      return canTrade ? (
        <BotPanel onSettings={() => open("bot", "settings")} />
      ) : (
        <BotPanel />
      );
    if (page === "trades") return <BotTrades onError={ignore} />;
    if (page === "settings" && canTrade)
      return <BotSettingsPage onBack={() => open("bot", "activity")} />;
    if (page === "s-activity")
      return canTrade ? (
        <StrangleActivity onSettings={() => open("strangle", "s-settings")} />
      ) : (
        <StrangleActivity />
      );
    if (page === "s-trades")
      return (
        <div className="portfolio">
          <BotAccount
            broker="alpaca"
            base="/api/portfolio/strangle"
            label="🎯 Alert leg · Alpaca paper"
            onError={ignore}
          />
        </div>
      );
    if (page === "s-settings" && canTrade)
      return (
        <StrangleSettingsPage onBack={() => open("strangle", "s-activity")} />
      );
    if (group === "strangle") return <StrangleActivity />;
    return <BotPanel />;
  };
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
        onKeyDown={(e) =>
          arrowTo(
            e,
            groups.map(([key]) => key),
            group,
            (next) => open(next, pages[next]),
            (key) => `tab-${key}`,
          )
        }
      >
        {groups.map(([key, label]) => (
          <button
            type="button"
            role="tab"
            key={key}
            id={`tab-${key}`}
            aria-selected={group === key}
            aria-controls={`panel-${pages[key]}`}
            tabIndex={group === key ? 0 : -1}
            onClick={() => open(key, pages[key])}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        role="tablist"
        aria-label={`${groupLabel} pages`}
        className="subtabs"
        onKeyDown={(e) =>
          arrowTo(
            e,
            visible.map(([key]) => key),
            page,
            (next) => open(group, next),
            (key) => `tab-${key}`,
          )
        }
      >
        {visible.map(([key, label]) => (
          <button
            type="button"
            role="tab"
            key={key}
            id={`tab-${key}`}
            aria-selected={page === key}
            aria-controls={`panel-${key}`}
            tabIndex={page === key ? 0 : -1}
            onClick={() => {
              // The page itself starts a new ticket, not the last order.
              setEditing(null);
              open(group, key);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id={`panel-${page}`}
        aria-labelledby={`tab-${page}`}
        className="tab-panel"
      >
        {panel()}
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

// The bot's own paper account (docs/tasks/backend-bot-account.md): what it
// holds and what it closed, read-only. The owner's position controls act on
// the owner's account, so nothing here can be clicked.
const botRefreshMs = 5000;

// The bot can trade at two accounts (docs/tasks/backend-bot-ibkr.md); the
// tab shows one at a time (user 2026-10-24: "show both, by toggle").
function BotTrades({ onError }: { onError: (m: string) => void }) {
  const [broker, setBroker] = useState<BotBroker>("alpaca");
  return (
    <div className="portfolio">
      <div className="toolbar">
        <div className="segmented small" role="group" aria-label="Bot account">
          {botBrokers.map((b) => (
            <button
              type="button"
              key={b}
              aria-pressed={broker === b}
              onClick={() => setBroker(b)}
            >
              {brokerNames[b]}
            </button>
          ))}
        </div>
        {broker === "ibkr" && (
          <span className="muted small">
            Shared with your own IBKR trades: the bot's contracts only; the
            account value is the whole account.
          </span>
        )}
      </div>
      <BotAccount key={broker} broker={broker} onError={onError} />
    </div>
  );
}

function BotAccount({
  broker,
  onError,
  // Another bot's own account (the strangle's: /api/portfolio/strangle).
  base = "/api/portfolio/bot",
  label,
}: {
  broker: BotBroker;
  onError: (m: string) => void;
  base?: string;
  label?: string;
}) {
  const query = broker === "alpaca" ? "" : `broker=${broker}`;
  const { value, at, error } = usePolling<PortfolioData>(
    `${base}${query ? `?${query}` : ""}`,
    botRefreshMs,
    onError,
  );
  if (!value)
    return (
      <p className={error ? "notice error" : "chart-status"}>
        {error
          ? `Bot account unavailable: ${error}`
          : "Loading the bot's account…"}
      </p>
    );
  const { account, positions, orders } = value;
  const openPnl = positions
    .map((p) => positionNumbers(p, "close", account.equity).pnl)
    .reduce<number>((sum, pnl) => sum + (pnl ?? 0), 0);
  return (
    <div className="portfolio">
      <p className="portfolio-meta">
        <span className="account-tag paper">
          {label ?? `🤖 Bot · ${brokerNames[broker]} paper`}
        </span>
        <span className="muted">
          {error
            ? `Update failed (${error}). Showing ${israelClock(Date.parse(value.at))} ${israelLabel}.`
            : `Updated ${israelClock(at ?? Date.parse(value.at))} ${israelLabel}`}
        </span>
      </p>
      <div className="account">
        <div className="account-main">
          <span className="account-label">
            {value.marketClosed ? "Account value at close" : "Net liquidation"}
          </span>
          <strong className="num">{usd(account.equity)}</strong>
          <span className={`num account-day${tone(account.dayChange)}`}>
            {signedUsd(account.dayChange)}
            {account.dayChangePct !== null &&
              ` (${signedPct(account.dayChangePct)})`}{" "}
            US session
          </span>
        </div>
        <dl className="account-stats">
          <div>
            <dt>Open P&L</dt>
            <dd className={`num${tone(openPnl)}`}>{signedUsd(openPnl)}</dd>
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
      <h2 className="portfolio-title">Positions</h2>
      {positions.length > 0 ? (
        <PositionList
          positions={positions}
          why={new Map()}
          view="close"
          equity={account.equity}
          controls={false}
        />
      ) : (
        <p className="notice">The bot holds nothing right now.</p>
      )}
      <h2 className="portfolio-title">Open orders</h2>
      {orders.length > 0 ? (
        <ul className="portfolio-orders">
          {orders.map((o) => (
            <Order
              key={o.id}
              o={o}
              position={positions.find((p) => p.symbol === o.symbol)}
            />
          ))}
        </ul>
      ) : (
        <p className="muted">No open orders.</p>
      )}
      <h2 className="portfolio-title">Closed trades</h2>
      <History onError={onError} base={base} chips={false} query={query} />
    </div>
  );
}
