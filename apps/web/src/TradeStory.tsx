import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { newYorkToUtc } from "../../../packages/market-data/src/calendar.js";
import type {
  TradeChart as TradeChartData,
  TradeChartSession,
} from "../../../packages/market-data/src/trade-chart.js";
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
import { niceTicks } from "./trade-history-model.js";
import {
  botStory,
  chartAxis,
  decisionFor,
  ownerStory,
  sessionGap,
  sessionOpen,
  tradeChartUrl,
  unknownStory,
  valueAt,
  type Marker,
  type Moment,
  type Story,
} from "./trade-story-model.js";
import { useWidth } from "./use-width.js";

// A closed trade's story (docs/tasks/frontend-trade-story.md), in a window
// over the History list: the stock and the option through the sessions the
// trade spanned, the entry and each exit marked on them, why it was entered,
// why each exit happened, and the fills. Bot trades are told from the bot's
// records; the owner's from the buy order and the fills.

const ignore = () => {};
const refreshMs = 60000;

const colors = {
  stock: "#2f4b8f",
  option: "#3b4a46",
  grid: "#e7ece6",
  text: "#52514e",
  buy: "#0e7a43",
  sell: "#c0322b",
  expired: "#6b7a76",
  signal: "#2f4b8f",
  touch: "#b5651d",
  paid: "#6b7a76",
  stop: "#c0322b",
  wall: "#b5651d",
  entry: "#2f4b8f",
  divider: "#cdd7ce",
  crosshair: "#142b29",
};

const dayLabel = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "short",
  day: "numeric",
  month: "short",
});
const sessionLabel = (date: string) =>
  dayLabel.format(Date.parse(`${date}T12:00:00Z`));
const clockAt = (date: string, minute: number) =>
  israelClock(newYorkToUtc(date, sessionOpen + minute));

function markerColor(kind: Marker["kind"]): string {
  if (kind === "buy") return colors.buy;
  if (kind === "sell") return colors.sell;
  if (kind === "signal") return colors.signal;
  if (kind === "touch") return colors.touch;
  return colors.expired;
}

interface Pane {
  top: number;
  height: number;
  ticks: number[];
  y: (v: number) => number;
}

function pane(top: number, height: number, values: number[]): Pane {
  const finite = values.filter((v) => Number.isFinite(v));
  const low = finite.length ? Math.min(...finite) : 0;
  const high = finite.length ? Math.max(...finite) : 1;
  const pad = Math.max((high - low) * 0.12, high * 0.004, 0.01);
  // Prices: the axis never goes below zero.
  const ticks = niceTicks(Math.max(0, low - pad), high + pad, 4);
  const min = ticks[0]!;
  const max = ticks.at(-1)!;
  return {
    top,
    height,
    ticks,
    y: (v: number) => top + ((max - v) / (max - min)) * height,
  };
}

const linePath = (
  sessions: TradeChartSession[],
  which: "stock" | "option",
  xAt: (v: number) => number,
  y: (v: number) => number,
  starts: Map<string, { start: number }>,
): string =>
  sessions
    .map((s) => {
      const start = starts.get(s.date)!.start;
      return s[which]
        .map(
          ([m, v], i) =>
            `${i === 0 ? "M" : "L"}${xAt(start + m).toFixed(1)},${y(v).toFixed(1)}`,
        )
        .join(" ");
    })
    .join(" ");

/** The stock and the option through the trade's sessions, with the entry and exits marked. */
function TradeChart({ chart, story }: { chart: TradeChartData; story: Story }) {
  const [frame, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<Moment | null>(null);
  const phone = width > 0 && width < 520;
  const top = 24;
  const stockH = phone ? 150 : 190;
  const between = chart.option ? 36 : 0;
  const optionH = chart.option ? (phone ? 120 : 150) : 0;
  const session = (date: string) => chart.sessions.find((s) => s.date === date);

  const stockValues = chart.sessions.flatMap((s) => s.stock.map((p) => p[1]));
  if (story.stockEntry !== null) stockValues.push(story.stockEntry);
  if (story.wall) stockValues.push(story.wall.level);
  const stock = pane(top, stockH, stockValues);
  const optionValues = chart.sessions.flatMap((s) => s.option.map((p) => p[1]));
  optionValues.push(story.paid);
  if (story.stop !== null) optionValues.push(story.stop);
  for (const m of story.markers)
    if (m.pane === "option" && m.price !== null) optionValues.push(m.price);
  const option = chart.option
    ? pane(top + stockH + between, optionH, optionValues)
    : null;
  // Room on the left for the longest price label ("$190.00").
  const longest = Math.max(
    ...stock.ticks.map((v) => `$${v.toFixed(2)}`.length),
    ...(option ? option.ticks.map((v) => v.toFixed(2).length) : [0]),
  );
  const margin = { top, right: 14, bottom: 26, left: 12 + longest * 6.6 };
  const height = margin.top + stockH + between + optionH + margin.bottom;
  const plotW = Math.max(1, width - margin.left - margin.right);
  const axis = chartAxis(chart.sessions);
  const xAt = (v: number) => margin.left + (v / axis.total) * plotW;
  const xOf = (m: Moment) => {
    const v = axis.xOf(m);
    return v === null ? null : xAt(v);
  };
  // A stock trade: every marker sits on the stock pane at its fill price.
  const paneOf = (m: Marker): Pane => {
    if (m.pane === "option" && option) return option;
    return stock;
  };
  const priceOf = (m: Marker): number | null => {
    if (m.price !== null && (m.pane === "stock" || chart.option))
      return m.price;
    const s = session(m.at.date);
    if (!s) return null;
    const pairs = m.pane === "option" && chart.option ? s.option : s.stock;
    return valueAt(pairs, m.at.minute);
  };
  const first = chart.sessions[0]?.date;
  const entryStock =
    story.stockEntry ??
    (() => {
      const buy = story.markers.find((m) => m.kind === "buy");
      if (!buy) return null;
      const s = session(buy.at.date);
      return s ? valueAt(s.stock, buy.at.minute) : null;
    })();

  // Time labels every half hour where there is room (about 48 px each), else
  // every hour, two or three.
  const pxPerMinute = plotW / axis.total;
  const tickEvery =
    [30, 60, 120, 180].find((m) => m * pxPerMinute >= 48) ?? 180;
  const bottom = margin.top + stockH + between + optionH;
  const hoverX = hover ? xOf(hover) : null;
  const hoverSession = hover ? session(hover.date) : undefined;
  const hoverStock = hoverSession
    ? valueAt(hoverSession.stock, hover!.minute)
    : null;
  const hoverOption =
    hoverSession && chart.option
      ? valueAt(hoverSession.option, hover!.minute)
      : null;

  const move = (clientX: number, rect: DOMRect) => {
    const v = ((clientX - rect.left - margin.left) / plotW) * axis.total;
    setHover(axis.at(v));
  };
  const money = (v: number, option: boolean) =>
    option ? v.toFixed(2) : `$${v.toFixed(2)}`;

  return (
    <div className="ts-chart" ref={frame}>
      {width > 0 && (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height={height}
          role="img"
          aria-label={`${chart.underlying} and the ${chart.option ? "option" : "stock"} through the trade, with the entry and exits marked`}
          onPointerMove={(e) =>
            move(e.clientX, e.currentTarget.getBoundingClientRect())
          }
          onPointerLeave={() => setHover(null)}
        >
          {/* Pane titles */}
          <text x={margin.left} y={margin.top - 10} className="ts-title">
            {chart.underlying} stock
          </text>
          {option && (
            <text x={margin.left} y={option.top - 10} className="ts-title">
              The option
              {story.version ? ` · bot ${story.version}` : ""}
            </text>
          )}
          {/* Grid and y axes */}
          {[stock, ...(option ? [option] : [])].map((p, i) =>
            p.ticks.map((v) => (
              <g key={`${i}-${v}`}>
                <line
                  x1={margin.left}
                  x2={width - margin.right}
                  y1={p.y(v)}
                  y2={p.y(v)}
                  stroke={colors.grid}
                />
                <text
                  x={margin.left - 6}
                  y={p.y(v) + 3}
                  textAnchor="end"
                  className="ts-axis"
                >
                  {money(v, i === 1)}
                </text>
              </g>
            )),
          )}
          {/* Sessions: time ticks, the date, and dividers */}
          {chart.sessions.map((s, i) => {
            const start = axis.offsets.get(s.date)!.start;
            const ticks: number[] = [];
            const last = i === chart.sessions.length - 1;
            for (let m = 0; m < s.minutes; m += tickEvery) {
              // A label too close to the next session's first one is dropped.
              const room = (s.minutes + sessionGap - m) * pxPerMinute;
              if (last || room >= 44) ticks.push(m);
            }
            return (
              <g key={s.date}>
                {ticks.map((m) => (
                  <text
                    key={m}
                    x={xAt(start + m)}
                    y={bottom + 16}
                    textAnchor="middle"
                    className="ts-axis"
                  >
                    {clockAt(s.date, m)}
                  </text>
                ))}
                {chart.sessions.length > 1 && (
                  <text
                    x={xAt(start)}
                    y={bottom + (phone ? 16 : 16)}
                    dy={-stockH - between - optionH - 4}
                    textAnchor="start"
                    className="ts-session"
                    dx={phone ? 70 : 90}
                  >
                    {sessionLabel(s.date)}
                  </text>
                )}
                {i > 0 && (
                  <line
                    x1={xAt(start - sessionGap / 2)}
                    x2={xAt(start - sessionGap / 2)}
                    y1={margin.top}
                    y2={bottom}
                    stroke={colors.divider}
                    strokeDasharray="3 4"
                  />
                )}
                {i === 1 && chart.skipped > 0 && (
                  <text
                    x={xAt(start - sessionGap / 2)}
                    y={margin.top + stockH / 2}
                    textAnchor="middle"
                    className="ts-axis"
                    transform={`rotate(-90 ${xAt(start - sessionGap / 2)} ${margin.top + stockH / 2})`}
                  >
                    {chart.skipped} session{chart.skipped === 1 ? "" : "s"} left
                    out
                  </text>
                )}
              </g>
            );
          })}
          {/* Levels */}
          {entryStock !== null && (
            <Level
              y={stock.y(entryStock)}
              x1={margin.left}
              x2={width - margin.right}
              color={colors.entry}
              dash="2 4"
              label={`entry $${entryStock.toFixed(2)}`}
            />
          )}
          {story.wall && (
            <Level
              y={stock.y(story.wall.level)}
              x1={margin.left}
              x2={width - margin.right}
              color={colors.wall}
              dash="6 4"
              label={`${story.wall.name} $${story.wall.level.toFixed(2)}`}
            />
          )}
          {option && (
            <Level
              y={option.y(story.paid)}
              x1={margin.left}
              x2={width - margin.right}
              color={colors.paid}
              dash="6 4"
              label={`paid ${story.paid.toFixed(2)}`}
            />
          )}
          {option && story.stop !== null && (
            <Level
              y={option.y(story.stop)}
              x1={margin.left}
              x2={width - margin.right}
              color={colors.stop}
              dash="2 4"
              label={`${story.stopLabel} ${story.stop.toFixed(2)}`}
            />
          )}
          {/* The lines */}
          <path
            d={linePath(chart.sessions, "stock", xAt, stock.y, axis.offsets)}
            fill="none"
            stroke={colors.stock}
            strokeWidth={1.6}
            strokeLinejoin="round"
          />
          {option && (
            <path
              d={linePath(
                chart.sessions,
                "option",
                xAt,
                option.y,
                axis.offsets,
              )}
              fill="none"
              stroke={colors.option}
              strokeWidth={1.6}
              strokeLinejoin="round"
            />
          )}
          {/* Markers: a guide through both panes, a dot and a label */}
          {story.markers.map((m, i) => {
            const x = xOf(m.at);
            const price = priceOf(m);
            if (x === null) return null;
            const p = paneOf(m);
            const color = markerColor(m.kind);
            const above = i % 2 === 0;
            const hollow = m.kind === "signal" || m.kind === "touch";
            const y = price === null ? p.top + p.height / 2 : p.y(price);
            const anchorRight = x > margin.left + plotW * 0.72;
            return (
              <g key={`${m.kind}-${m.ms}-${i}`}>
                <line
                  x1={x}
                  x2={x}
                  y1={margin.top}
                  y2={bottom}
                  stroke={color}
                  strokeOpacity={0.3}
                />
                {price !== null && (
                  <circle
                    cx={x}
                    cy={y}
                    r={5}
                    fill={hollow ? "#fafbf8" : color}
                    stroke={color}
                    strokeWidth={2}
                  />
                )}
                <text
                  x={x + (anchorRight ? -8 : 8)}
                  y={y + (above ? -9 : 15)}
                  textAnchor={anchorRight ? "end" : "start"}
                  className="ts-mark"
                  fill={color}
                >
                  {m.label}
                </text>
              </g>
            );
          })}
          {/* Crosshair */}
          {hoverX !== null && (
            <line
              x1={hoverX}
              x2={hoverX}
              y1={margin.top}
              y2={bottom}
              stroke={colors.crosshair}
              strokeOpacity={0.5}
            />
          )}
          {first === undefined && (
            <text x={margin.left} y={margin.top + 40} className="ts-axis">
              No bars for these days.
            </text>
          )}
        </svg>
      )}
      {hover && hoverX !== null && (
        <div
          className="ts-tip"
          style={{
            left: hoverX,
            transform: hoverX > width * 0.7 ? "translateX(-100%)" : undefined,
          }}
        >
          <strong>{clockAt(hover.date, hover.minute)}</strong>
          {chart.sessions.length > 1 && ` · ${sessionLabel(hover.date)}`}
          <br />
          {chart.underlying}{" "}
          {hoverStock !== null ? `$${hoverStock.toFixed(2)}` : "—"}
          {chart.option && (
            <>
              <br />
              option{" "}
              {hoverOption !== null ? hoverOption.toFixed(2) : "no trade yet"}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Level({
  y,
  x1,
  x2,
  color,
  dash,
  label,
}: {
  y: number;
  x1: number;
  x2: number;
  color: string;
  dash: string;
  label: string;
}) {
  return (
    <g>
      <line
        x1={x1}
        x2={x2}
        y1={y}
        y2={y}
        stroke={color}
        strokeDasharray={dash}
      />
      <text x={x2} y={y - 4} textAnchor="end" className="ts-level" fill={color}>
        {label}
      </text>
    </g>
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
  useEffect(() => {
    let live = true;
    fetch(tradeChartUrl(t))
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
  const { value: view } = usePolling<BotView>("/api/bot", refreshMs, ignore);
  const { value: orders } = usePolling<OrderDecisions>(
    "/api/portfolio/orders",
    refreshMs,
    ignore,
  );
  let story: Story | null = null;
  if (bot) {
    story = botStory(t, view, view?.settings ?? defaultSettings);
    if (!story && view) story = unknownStory(t);
  }
  if (!story && !bot)
    story = ownerStory(t, decisionFor(t, orders?.decisions ?? []));
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
          {chart && story ? (
            <TradeChart chart={chart} story={story} />
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
