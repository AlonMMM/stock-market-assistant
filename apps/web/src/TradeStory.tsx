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
  lastClosedSession,
  mergeSessions,
  ownerStory,
  pageDays,
  tradeChartUrl,
  unknownStory,
  type Story,
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

/** The window: chart, why entered, why exited, the fills. */
export function TradeStory({
  t,
  bot,
  onClose,
}: {
  t: ClosedTrade;
  bot: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const [chart, setChart] = useState<TradeChartData | null>(null);
  const [chartError, setChartError] = useState("");
  const [view, setView] = useState<ChartView>("day");
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

  useEffect(() => {
    let live = true;
    const { from, to } = chartWindow(t, Date.now());
    fetch(tradeChartUrl(t.symbol, from, to))
      .then((r) => readJson<TradeChartData>(r))
      .then((c) => {
        if (live) setChart(c);
      })
      .catch((e: Error) => {
        if (live) setChartError(e.message);
      });
    return () => {
      live = false;
    };
  }, [t]);

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
        const closed = lastClosedSession(Date.now());
        const after = nextSessions(last, pageDays).filter((d) => d <= closed);
        if (after.length === 0) {
          edge.done = true;
          return;
        }
        from = after[0]!;
        to = after.at(-1)!;
      }
      edge.loading = true;
      fetch(tradeChartUrl(t.symbol, from, to))
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
    [t.symbol],
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

  const { value: botView } = usePolling<BotView>("/api/bot", refreshMs, ignore);
  const { value: orders } = usePolling<OrderDecisions>(
    "/api/portfolio/orders",
    refreshMs,
    ignore,
  );
  // The story is built once per answer: the chart redraws its lines and
  // markers when it changes, and the crosshair readout re-renders often.
  const story = useMemo<Story | null>(() => {
    if (bot) {
      const own = botStory(t, botView, botView?.settings ?? defaultSettings);
      if (own) return own;
      return botView ? unknownStory(t) : null;
    }
    return ownerStory(t, decisionFor(t, orders?.decisions ?? []));
  }, [t, bot, botView, orders]);
  const multiplier = t.option ? 100 : 1;
  const fills = t.fills ?? [];
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
              {optionName(t)} {bot && <BotChip />}
            </h2>
            <p className="muted">
              {t.option ? `${expiryLabel(t.option.expiry)} · ` : ""}
              {t.qty} {unit}
              {t.qty === 1 ? "" : "s"} · {opened} → {closed} · {israelLabel}
              {story?.version ? ` · bot ${story.version}` : ""}
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
              />
            </Suspense>
          ) : (
            <p className="chart-status">
              {chartError ? `No chart: ${chartError}` : "Loading the chart…"}
            </p>
          )}
        </section>
        {story ? (
          <>
            <section>
              <h3>{story.entryTitle}</h3>
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
              <h3>Why it was exited</h3>
              {story.exits.length > 0 ? (
                <ol className="ts-exits">
                  {story.exits.map((x, i) => (
                    <li key={`${x.ms}-${i}`}>
                      <div className="ts-exit-head">
                        <strong>{x.title}</strong>
                        <span className="muted num">
                          {israelClock(x.ms)} · {x.qty} {unit}
                          {x.qty === 1 ? "" : "s"}
                          {x.price !== null && ` at ${x.price.toFixed(2)}`}
                        </span>
                      </div>
                      {x.text && <p>{x.text}</p>}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted">No sale is recorded for this trade.</p>
              )}
            </section>
          </>
        ) : (
          <p className="chart-status">Loading the bot&apos;s records…</p>
        )}
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
                  Result
                </th>
                <td className={tone(t.pnl).trim()}>{signedUsd(t.pnl)}</td>
              </tr>
            </tfoot>
          </table>
        </section>
      </div>
    </dialog>,
    document.body,
  );
}

function fillWord(side: "buy" | "sell" | "expired"): string {
  if (side === "buy") return "Buy";
  if (side === "sell") return "Sell";
  return "Expired";
}
