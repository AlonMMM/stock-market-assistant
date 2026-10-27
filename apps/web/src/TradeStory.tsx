import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  nextSessions,
  previousSessions,
} from "../../../packages/market-data/src/calendar.js";
import type { TradeChart as TradeChartData } from "../../../packages/market-data/src/trade-chart.js";
import type { BotView } from "../../../packages/trading/src/bot-api.js";
import { defaultSettings } from "../../../packages/trading/src/bot/settings.js";
import type { OrderDecisions } from "../../../packages/trading/src/decisions-api.js";
import type { ClosedTrade } from "../../../packages/trading/src/portfolio.js";
import type { StrangleView } from "../../../packages/trading/src/strangle/view.js";
import { readJson } from "./api.js";
import { BotChip } from "./BotPanel.js";
import {
  expiryLabel,
  optionName,
  signedPct,
  signedUsd,
  tone,
  usd,
} from "./format.js";
import { usePolling } from "./Live.js";
import { WhyButton } from "./Orders.js";
import { israelClock, israelDateTime, israelLabel } from "./time.js";
import {
  botStory,
  chartWindow,
  decisionFor,
  heldText,
  lastOpenSession,
  mergeSessions,
  ownerStory,
  pageDays,
  tradeChartUrl,
  tradeStats,
  askMoved,
  quotePlace,
  unknownStory,
  volumeStory,
  type EntryQuote,
  type PricePoint,
  type Story,
  type TradeStats,
} from "./trade-story-model.js";
import type { ChartStyle, ChartView, Hover } from "./TradeStoryChart.js";

// A closed trade's story (docs/tasks/frontend-trade-story.md), in a window
// over the History list: the days around the trade on a chart that zooms and
// scrolls (the stock with SPY, the volume, the bot's strength against SPY,
// the option and its volume), the entry and each exit marked on it, why it
// was entered, why each exit happened, and the fills. Bot trades are told
// from the bot's records; the owner's from the buy order and the fills.

const TradeStoryChart = lazy(() =>
  import("./TradeStoryChart.js").then((m) => ({ default: m.TradeStoryChart })),
);

const ignore = () => {};
const refreshMs = 60000;
const styleKey = "trade-story-style";

const views: { id: ChartView; label: string }[] = [
  { id: "trade", label: "The trade" },
  { id: "day", label: "Trade day" },
  { id: "all", label: "All days" },
];
const styles: { id: ChartStyle; label: string }[] = [
  { id: "line", label: "Line" },
  { id: "candles", label: "Candles" },
];

function savedStyle(): ChartStyle {
  try {
    return localStorage.getItem(styleKey) === "candles" ? "candles" : "line";
  } catch {
    return "line";
  }
}

const crosshairDay = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "short",
  day: "numeric",
  month: "short",
});
const crosshairClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** What the crosshair is over: the time, the stock and SPY, the bot's numbers, the option. */
function Readout({ hover, chart }: { hover: Hover; chart: TradeChartData }) {
  const ms = hover.time * 1000;
  return (
    <p className="ts-readout num">
      <strong>
        {crosshairDay.format(ms)} · {crosshairClock.format(ms)}
      </strong>
      <span>
        {chart.underlying}{" "}
        {hover.stock !== null ? `$${hover.stock.toFixed(2)}` : "—"}
      </span>
      {hover.spy !== null && <span>SPY ${hover.spy.toFixed(2)}</span>}
      {hover.volume !== null && <span>vol {compact.format(hover.volume)}</span>}
      {hover.t !== null && (
        <span>
          strength t {hover.t.toFixed(1)}
          {hover.rvol !== null && ` · volume ${hover.rvol.toFixed(1)}× usual`}
        </span>
      )}
      {chart.option && (
        <span>
          option {hover.option !== null ? hover.option.toFixed(2) : "no trade"}
        </span>
      )}
    </p>
  );
}

const pctText = (n: number) =>
  `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`;
const pctTone = (n: number) => (n > 0 ? " up" : n < 0 ? " down" : "");

function Point({ label, p }: { label: string; p: PricePoint | null }) {
  if (!p) return null;
  return (
    <span>
      {label} <b className="num">{p.price.toFixed(2)}</b>{" "}
      <b className={`num${pctTone(p.pct)}`}>{pctText(p.pct)}</b>{" "}
      <span className="muted num">at {israelClock(p.ms)}</span>
    </span>
  );
}

/**
 * The entry against the option's bid and ask when the buy was decided (user
 * 2026-10-27: "I want to see the enter in term of bid ask price mid"): the
 * spread as a bar, the mid marked on it and a dot where the fill landed.
 */
function QuoteBar({ q, price }: { q: EntryQuote; price: number }) {
  const mid = (q.bid + q.ask) / 2;
  const lo = Math.min(q.bid, price);
  const hi = Math.max(q.ask, price);
  const span = hi - lo || 1;
  const at = (v: number) => `${((v - lo) / span) * 100}%`;
  const spread = q.ask - q.bid;
  // Judged against the book at the fill when known: a chased buy follows the
  // ask up, so the book at the decision alone looked "over the ask" (user
  // 2026-10-27: "how can we buy higher than the ask?").
  const place = quotePlace(price, q.fill ?? q);
  const moved = askMoved(q);
  const stale = !q.fill && price > q.ask + 0.005;
  return (
    <div className="ts-quote">
      <div
        className="ts-quote-bar"
        role="img"
        aria-label={`Bid ${q.bid.toFixed(2)}, mid ${mid.toFixed(3)}, ask ${q.ask.toFixed(2)}; bought ${price.toFixed(2)}, ${place}`}
      >
        <span
          className="ts-quote-spread"
          style={{ left: at(q.bid), width: `${(spread / span) * 100}%` }}
        />
        <span className="ts-quote-mid" style={{ left: at(mid) }} />
        <span className="ts-quote-fill" style={{ left: at(price) }} />
      </div>
      <p className="ts-quote-nums num">
        <span>bid {q.bid.toFixed(2)}</span>
        <span>mid {Number(mid.toFixed(3))}</span>
        <span>ask {q.ask.toFixed(2)}</span>
      </p>
      <p className="muted num">
        Paid {price.toFixed(2)}: <b>{place}</b>
        {stale && " when the order was sent (the ask moved up while buying)"}
        {moved && ` · ${moved}`}
        {mid > 0 &&
          ` · spread ${spread.toFixed(2)} (${((spread / mid) * 100).toFixed(0)}% of the mid)`}
      </p>
    </div>
  );
}

/**
 * An open trade in brief, under its position (user 2026-10-27: "we can
 * reduce the information. Its too much"): the entry against its bid and ask,
 * and where it stands now.
 */
function CompactSummary({
  stats,
  t,
  unit,
  quote,
}: {
  stats: TradeStats;
  t: ClosedTrade;
  unit: string;
  quote: EntryQuote | null;
}) {
  const plural = (n: number) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const moves: [string, number][] = [];
  if (stats.stock) moves.push([t.underlying, stats.stock.pct]);
  if (stats.spyPct !== null) moves.push(["SPY", stats.spyPct]);
  if (stats.best) moves.push(["best", stats.best.pct]);
  if (stats.worst) moves.push(["worst", stats.worst.pct]);
  return (
    <div className="ts-summary compact">
      <div className="ts-cell buy">
        <h4>Entry</h4>
        <p className="num">
          <b>{israelClock(stats.entry.ms)}</b> · {plural(stats.entry.qty)} at{" "}
          <b>{stats.entry.price.toFixed(2)}</b>
        </p>
        {quote ? (
          <QuoteBar q={quote} price={stats.entry.price} />
        ) : (
          <p className="muted">The bid and ask at the entry were not kept.</p>
        )}
      </div>
      <div className="ts-cell">
        <h4>Now</h4>
        <p className="num">
          <b>{heldText(stats.heldMs)}</b> ·{" "}
          <b className={tone(t.pnl).trim()}>
            {signedUsd(t.pnl)}
            {t.pnlPct !== null && ` (${signedPct(t.pnlPct)})`}
          </b>
        </p>
        {moves.length > 0 && (
          <p className="muted num">
            {moves.map(([label, pct], i) => (
              <span key={label}>
                {i > 0 && " · "}
                {label} <span className={pctTone(pct)}>{pctText(pct)}</span>
              </span>
            ))}
          </p>
        )}
        {stats.exits.map((x, i) => (
          <p key={`${x.ms}-${i}`} className="num">
            Sold {plural(x.qty)}
            {x.price !== null && ` at ${x.price.toFixed(2)}`} ·{" "}
            {israelClock(x.ms)} · {x.title}
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * The trade at a glance, above the chart (user 2026-10-26: "make it easy to a
 * human to analyze the enter and exit"): the entry, each exit, the time held
 * and the result, the option's best and worst while held, how the stock and
 * SPY moved, and what the option did after the sale.
 */
function Summary({
  stats,
  t,
  unit,
  live,
  quote,
}: {
  stats: TradeStats;
  t: ClosedTrade;
  unit: string;
  live: boolean;
  quote: EntryQuote | null;
}) {
  const plural = (n: number) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  return (
    <div className="ts-summary">
      <div className="ts-cell buy">
        <h4>Entry</h4>
        <p className="num">
          <b>{israelClock(stats.entry.ms)}</b> · bought{" "}
          {plural(stats.entry.qty)} at <b>{stats.entry.price.toFixed(2)}</b>
        </p>
        {stats.entry.stock !== null && (
          <p className="muted num">
            {t.underlying} at ${stats.entry.stock.toFixed(2)}
          </p>
        )}
        {quote && <QuoteBar q={quote} price={stats.entry.price} />}
      </div>
      <div className="ts-cell sell">
        <h4>
          {live ? "Sold so far" : `Exit${stats.exits.length === 1 ? "" : "s"}`}
        </h4>
        {stats.exits.length === 0 && (
          <p className="muted">{live ? "Nothing yet." : "No sale recorded."}</p>
        )}
        {stats.exits.map((x, i) => (
          <p key={`${x.ms}-${i}`} className="num">
            <b>{israelClock(x.ms)}</b> · {plural(x.qty)}
            {x.price !== null && (
              <>
                {" "}
                at <b>{x.price.toFixed(2)}</b>{" "}
                <span className={pctTone(x.price - stats.entry.price)}>
                  {pctText((x.price / stats.entry.price - 1) * 100)}
                </span>
              </>
            )}{" "}
            · {x.title}
          </p>
        ))}
      </div>
      <div className="ts-cell">
        <h4>{live ? "Held so far" : "Held"}</h4>
        <p className="num">
          <b>{heldText(stats.heldMs)}</b> ·{" "}
          <b className={tone(t.pnl).trim()}>
            {signedUsd(t.pnl)}
            {t.pnlPct !== null && ` (${signedPct(t.pnlPct)})`}
          </b>
        </p>
        {stats.stock && (
          <p className="muted num">
            {t.underlying} ${stats.stock.from.toFixed(2)} → $
            {stats.stock.to.toFixed(2)}{" "}
            <span className={pctTone(stats.stock.pct)}>
              {pctText(stats.stock.pct)}
            </span>
            {stats.spyPct !== null && (
              <>
                {" "}
                · SPY{" "}
                <span className={pctTone(stats.spyPct)}>
                  {pctText(stats.spyPct)}
                </span>
              </>
            )}
          </p>
        )}
      </div>
      <div className="ts-cell">
        <h4>While held</h4>
        {stats.best || stats.worst ? (
          <p className="ts-points">
            <Point label="Best" p={stats.best} />
            <Point label="Worst" p={stats.worst} />
          </p>
        ) : (
          <p className="muted">The option did not trade while held.</p>
        )}
      </div>
      {!live && (
        <div className="ts-cell">
          <h4>After the sale</h4>
          {stats.afterBest || stats.afterClose ? (
            <p className="ts-points">
              <Point label="Highest" p={stats.afterBest} />
              <Point label="Last" p={stats.afterClose} />
            </p>
          ) : (
            <p className="muted">
              No trade in the option after the sale that day.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Whose trade: the owner's, the Main bot's or the volume bot's. */
export type TradeSource = "owner" | "main" | "volume";

/** The window over the History list: a closed trade's story. */
export function TradeStory({
  t,
  bot,
  source = bot ? "main" : "owner",
  onClose,
}: {
  t: ClosedTrade;
  bot: boolean;
  source?: TradeSource;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const opened = israelDateTime(Date.parse(t.openedAt));
  const closed = t.expired
    ? `expiry ${t.closedAt.slice(0, 10)}`
    : israelDateTime(Date.parse(t.closedAt));
  const unit = t.option ? "contract" : "share";
  return createPortal(
    <dialog
      ref={ref}
      className="why trade-story"
      aria-labelledby="ts-title"
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === ref.current) ref.current?.close();
      }}
    >
      <div className="why-body">
        <header className="why-head">
          <div>
            <h2 id="ts-title">
              {optionName(t)} {source !== "owner" && <BotChip />}
            </h2>
            <p className="muted">
              {t.option ? `${expiryLabel(t.option.expiry)} · ` : ""}
              {t.qty} {unit}
              {t.qty === 1 ? "" : "s"} · {opened} → {closed} · {israelLabel}
            </p>
          </div>
          <span className={`ts-result num${tone(t.pnl)}`}>
            {signedUsd(t.pnl)}
            {t.pnlPct !== null && ` (${signedPct(t.pnlPct)})`}
          </span>
          <button
            type="button"
            className="why-close"
            aria-label="Close"
            onClick={() => ref.current?.close()}
          >
            ×
          </button>
        </header>
        <TradeStoryBody t={t} source={source} />
      </div>
    </dialog>,
    document.body,
  );
}

// An open trade's chart reads its last session again this often.
const liveChartMs = 20000;

/**
 * The trade's story: summary, chart, why entered, the exits and the fills.
 * In the window for a closed trade, and in place of the plain chart under an
 * open position (`live`: the contracts still held; user 2026-10-27).
 */
export function TradeStoryBody({
  t,
  source,
  live,
  compact = false,
}: {
  t: ClosedTrade;
  source: TradeSource;
  live?: { held: number };
  // Under a position: the brief summary, the stock and option panes, the
  // reasons folded, no fills table.
  compact?: boolean;
}) {
  const [chart, setChart] = useState<TradeChartData | null>(null);
  const [chartError, setChartError] = useState("");
  // The trade's own minutes first: the entry and the exit up close.
  const [view, setView] = useState<ChartView>("trade");
  const [viewKey, setViewKey] = useState(0);
  const [style, setStyle] = useState<ChartStyle>(savedStyle);
  const [hover, setHover] = useState<Hover | null>(null);
  // More days are read as the viewer drags past the first or last one; each
  // side is read once at a time and no more once there is nothing before or after.
  const edges = useRef({
    before: { loading: false, done: false },
    after: { loading: false, done: false },
  });
  const chartRef = useRef(chart);
  chartRef.current = chart;
  // A live trade's `t` is rebuilt with each price; the chart is read once
  // per trade, then its last session again while it is open.
  const opened = t.openedAt;
  const symbol = t.symbol;
  const isLive = live !== undefined;
  const closedAt = isLive ? null : t.closedAt;

  useEffect(() => {
    let active = true;
    const { from, to } = chartWindow(
      { openedAt: opened, closedAt: closedAt ?? new Date().toISOString() },
      Date.now(),
    );
    fetch(tradeChartUrl(symbol, from, to))
      .then((r) => readJson<TradeChartData>(r))
      .then((c) => {
        if (active) setChart(c);
      })
      .catch((e: Error) => {
        if (active) setChartError(e.message);
      });
    return () => {
      active = false;
    };
  }, [symbol, opened, closedAt]);

  useEffect(() => {
    if (!isLive) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const last = lastOpenSession(Date.now());
      fetch(tradeChartUrl(symbol, last, last))
        .then((r) => readJson<TradeChartData>(r))
        .then((more) =>
          setChart((old) => (old ? mergeSessions(old, more) : more)),
        )
        .catch(() => {
          // Keep what is drawn; the next read may work.
        });
    }, liveChartMs);
    return () => clearInterval(timer);
  }, [isLive, symbol]);

  const onEdge = useCallback(
    (side: "before" | "after") => {
      const edge = edges.current[side];
      const current = chartRef.current;
      if (
        edge.loading ||
        edge.done ||
        !current ||
        current.sessions.length === 0
      )
        return;
      const first = current.sessions[0]!.date;
      const last = current.sessions.at(-1)!.date;
      let from: string;
      let to: string;
      if (side === "before") {
        from = previousSessions(first, pageDays)[0]!;
        to = previousSessions(first, 1)[0]!;
      } else {
        const open = lastOpenSession(Date.now());
        const after = nextSessions(last, pageDays).filter((d) => d <= open);
        if (after.length === 0) {
          edge.done = true;
          return;
        }
        from = after[0]!;
        to = after.at(-1)!;
      }
      edge.loading = true;
      fetch(tradeChartUrl(symbol, from, to))
        .then((r) => readJson<TradeChartData>(r))
        .then((more) => {
          if (more.sessions.length === 0) edge.done = true;
          setChart((old) => (old ? mergeSessions(old, more) : more));
        })
        .catch(() => {
          edge.done = true; // keep what is drawn
        })
        .finally(() => {
          edge.loading = false;
        });
    },
    [symbol],
  );

  const chooseView = (v: ChartView) => {
    setView(v);
    setViewKey((k) => k + 1);
  };
  const chooseStyle = (s: ChartStyle) => {
    setStyle(s);
    try {
      localStorage.setItem(styleKey, s);
    } catch {
      // A private window: the choice lasts for this window only.
    }
  };

  // The bot's records: the Main bot's or the volume bot's.
  const { value: records } = usePolling<BotView | StrangleView>(
    source === "volume" ? "/api/strangle" : "/api/bot",
    refreshMs,
    ignore,
  );
  const { value: orders } = usePolling<OrderDecisions>(
    "/api/portfolio/orders",
    refreshMs,
    ignore,
  );
  // The story is built once per answer: the chart redraws its lines and
  // markers when it changes, and the crosshair readout re-renders often.
  const story = useMemo<Story | null>(() => {
    if (source === "volume") {
      const own = volumeStory(t, records as StrangleView | null);
      if (own) return own;
      return records ? unknownStory(t, "volume") : null;
    }
    if (source === "main") {
      const botView = records as BotView | null;
      const own = botStory(t, botView, botView?.settings ?? defaultSettings);
      if (own) return own;
      return botView ? unknownStory(t) : null;
    }
    return ownerStory(t, decisionFor(t, orders?.decisions ?? []));
  }, [t, source, records, orders]);
  const stats = useMemo(
    () => (story && chart ? tradeStats(t, story, chart) : null),
    [t, story, chart],
  );
  const multiplier = t.option ? 100 : 1;
  const fills = t.fills ?? [];
  const unit = t.option ? "contract" : "share";
  const plural = (n: number) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  return (
    <>
      {stats &&
        (compact ? (
          <CompactSummary
            stats={stats}
            t={t}
            unit={unit}
            quote={story?.entryQuote ?? null}
          />
        ) : (
          <Summary
            stats={stats}
            t={t}
            unit={unit}
            live={isLive}
            quote={story?.entryQuote ?? null}
          />
        ))}
      <section className="ts-chart-section">
        <div className="ts-bar">
          <div
            className="segmented small"
            role="group"
            aria-label="What the chart shows"
          >
            {views.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={view === v.id}
                onClick={() => chooseView(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
          <div
            className="segmented small"
            role="group"
            aria-label="How prices are drawn"
          >
            {styles.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={style === s.id}
                onClick={() => chooseStyle(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          {hover && chart && <Readout hover={hover} chart={chart} />}
        </div>
        {chart && story ? (
          <Suspense fallback={<div className="ts-chart" />}>
            <TradeStoryChart
              chart={chart}
              story={story}
              view={view}
              viewKey={viewKey}
              style={style}
              onEdge={onEdge}
              onHover={setHover}
              compact={compact}
            />
          </Suspense>
        ) : (
          <p className="chart-status">
            {chartError ? `No chart: ${chartError}` : "Loading the chart…"}
          </p>
        )}
      </section>
      {compact && story && (
        <details className="ts-why-more">
          <summary>
            {story.entryTitle}
            {story.version && (
              <span className="muted"> · bot {story.version}</span>
            )}
          </summary>
          <ul className="ts-why">
            {story.entry.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {story.decision && (
            <p className="ts-more">
              <WhyButton decision={story.decision} /> opens the full order.
            </p>
          )}
        </details>
      )}
      {!compact &&
        (story ? (
          <>
            <section>
              <h3>
                {story.entryTitle}
                {story.version && (
                  <span className="muted small"> · bot {story.version}</span>
                )}
              </h3>
              <ul className="ts-why">
                {story.entry.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {story.decision && (
                <p className="ts-more">
                  <WhyButton decision={story.decision} /> opens the full order:
                  every input, the chain and each check.
                </p>
              )}
            </section>
            <section>
              <h3>{isLive ? "Exits so far" : "Why it was exited"}</h3>
              {story.exits.length > 0 && (
                <ol className="ts-exits">
                  {story.exits.map((x, i) => (
                    <li key={`${x.ms}-${i}`}>
                      <div className="ts-exit-head">
                        <strong>{x.title}</strong>
                        <span className="muted num">
                          {israelClock(x.ms)} · {plural(x.qty)}
                          {x.price !== null && ` at ${x.price.toFixed(2)}`}
                        </span>
                      </div>
                      {x.text && <p>{x.text}</p>}
                    </li>
                  ))}
                </ol>
              )}
              {live ? (
                <p className="muted">Still open: {plural(live.held)} held.</p>
              ) : (
                story.exits.length === 0 && (
                  <p className="muted">No sale is recorded for this trade.</p>
                )
              )}
            </section>
          </>
        ) : (
          <p className="chart-status">Loading the bot&apos;s records…</p>
        ))}
      {!compact && (
        <section>
          <h3>Fills</h3>
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
                  <td>{fillWord(f.side)}</td>
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
                  {isLive ? "Result so far, at the last price" : "Result"}
                </th>
                <td className={tone(t.pnl).trim()}>{signedUsd(t.pnl)}</td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}
    </>
  );
}

function fillWord(side: "buy" | "sell" | "expired"): string {
  if (side === "buy") return "Buy";
  if (side === "sell") return "Sell";
  return "Expired";
}
