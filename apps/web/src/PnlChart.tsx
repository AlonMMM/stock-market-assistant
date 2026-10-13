import { useEffect, useId, useRef, useState } from "react";
import type { PortfolioHistory } from "../../../packages/trading/src/portfolio.js";
import {
  cumulativeTrades,
  monotonePath,
  nearestPoint,
  niceTicks,
  tradeTimeDomain,
  timeTicks,
} from "./trade-history-model.js";
import {
  israelDateTime,
  israelLabel,
  israelShortDate,
  israelWallSeconds,
} from "./time.js";

const colors = {
  up: "#16a34a",
  down: "#dc2626",
  flat: "#64748b",
  zero: "#858b85",
  grid: "#e7ece6",
  text: "#52514e",
  crosshair: "#142b29",
};

const money = (n: number) =>
  `${n < 0 ? "−" : n > 0 ? "+" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const percent = (n: number) =>
  `${n < 0 ? "−" : n > 0 ? "+" : ""}${Math.abs(n).toFixed(2)}%`;
// Axis labels: compact, no forced sign.
const axisMoney = (n: number) =>
  `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", {
    notation: Math.abs(n) >= 10000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 2,
  })}`;
const axisPercent = (n: number) =>
  `${n < 0 ? "−" : ""}${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
const tone = (n: number) =>
  n > 0 ? colors.up : n < 0 ? colors.down : colors.flat;

const margin = { top: 14, right: 18, bottom: 30, left: 64 };

/** Width of the element, following resizes. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Realized P&L through each close as a smooth line on a true time axis;
 * each dot is one closed trade.
 */
export function PnlChart({ history }: { history: PortfolioHistory }) {
  const [unit, setUnit] = useState<"usd" | "pct">("usd");
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [frame, width] = useWidth<HTMLDivElement>();
  const clip = useId().replace(/:/g, "");
  const points = cumulativeTrades(history.trades, history.baseEquity);
  const equityChart = history.baseEquity !== null;
  const pctAvailable = history.baseEquity !== null && history.baseEquity > 0;
  const showPct = unit === "pct" && pctAvailable;
  const format = showPct ? percent : money;
  const axisFormat = showPct ? axisPercent : axisMoney;
  const value = (p: (typeof points)[number]) =>
    showPct ? p.pct! : equityChart ? history.baseEquity! + p.pnl : p.pnl;
  const tradeValue = (p: (typeof points)[number]) =>
    showPct ? (p.trade.pnl / history.baseEquity!) * 100 : p.trade.pnl;
  const baseline = showPct || !equityChart ? 0 : history.baseEquity!;

  const height = width > 0 && width < 520 ? 260 : 340;
  const plotW = Math.max(1, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;
  const values = points.map(value);
  const dataMin = Math.min(...values, baseline);
  const dataMax = Math.max(...values, baseline);
  const padding = Math.max(1, (dataMax - dataMin) * 0.12);
  const yTicks = niceTicks(dataMin - padding, dataMax + padding, 5);
  const min = yTicks[0]!;
  const max = yTicks.at(-1)!;
  const [start, end] = tradeTimeDomain(
    points.map((p) => p.time),
    Date.parse(history.from),
    Date.parse(history.at),
  );
  const x = (time: number) =>
    margin.left + ((time - start) / (end - start)) * plotW;
  const y = (v: number) => margin.top + ((max - v) / (max - min)) * plotH;
  const offset = israelWallSeconds(start / 1000) * 1000 - start;
  const xTicks = timeTicks(
    start,
    end,
    Math.max(3, Math.floor(plotW / 100)),
    offset,
  );

  // Show only the realized path between closes; do not imply a flat $0 line
  // during periods with no closed trades.
  const tradeVertices: [number, number][] = points.map(
    (p): [number, number] => [x(p.time), y(value(p))],
  );
  const vertices: [number, number][] =
    !showPct && points.length > 0 && equityChart
      ? [[x(points[0]!.time) - 1, y(history.baseEquity!)], ...tradeVertices]
      : tradeVertices;
  const line = monotonePath(vertices);
  const area = `${line} V ${y(baseline)} H ${x(start)} Z`;

  const shown = hover ?? selected;
  const active = shown !== null ? points[shown] : undefined;
  const last = points.at(-1);
  const pick = (clientX: number, rect: DOMRect) => {
    const time =
      start + ((clientX - rect.left - margin.left) / plotW) * (end - start);
    const i = nearestPoint(
      points.map((p) => p.time),
      time,
    );
    return i < 0 ? null : i;
  };
  const describe = (p: (typeof points)[number]) =>
    `${p.trade.symbol} · ${israelDateTime(p.time)} ${israelLabel} · Trade: ${format(tradeValue(p))} · Account value: ${format(value(p))}`;

  const tooltipLeft = active ? x(active.time) : 0;
  const tooltipTop = active ? y(value(active)) : 0;

  return (
    <section
      className="trade-pnl-chart"
      aria-label={
        equityChart
          ? "Realized account value over time"
          : "Cumulative realized profit and loss over time"
      }
    >
      <div className="toolbar">
        <div className="trade-pnl-heading">
          <strong>
            {showPct
              ? "Cumulative realized return"
              : equityChart
                ? "Realized account value"
                : "Cumulative realized P&L"}
          </strong>
          {last && (
            <span
              className="trade-pnl-total num"
              style={{ color: tone(last.pnl) }}
            >
              {showPct || !equityChart
                ? format(value(last))
                : `$${value(last).toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
            </span>
          )}
        </div>
        <div className="segmented small" role="group" aria-label="Chart units">
          <button
            type="button"
            aria-pressed={!showPct}
            onClick={() => setUnit("usd")}
          >
            $
          </button>
          <button
            type="button"
            aria-pressed={showPct}
            disabled={!pctAvailable}
            onClick={() => setUnit("pct")}
          >
            %
          </button>
        </div>
      </div>
      <p className="muted">
        {points.length} closed {points.length === 1 ? "trade" : "trades"} · one
        dot per trade
        {showPct
          ? " · of starting account value"
          : equityChart
            ? ` · starts at $${history.baseEquity!.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
            : ""}{" "}
        · {israelLabel}
      </p>
      <div className="trade-pnl-frame" ref={frame}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`${equityChart ? "Realized account value" : "Cumulative realized P&L"} in ${showPct ? "percent return" : "dollars"} by closing time`}
            tabIndex={0}
            className="trade-pnl-svg"
            onPointerMove={(event) =>
              setHover(
                pick(
                  event.clientX,
                  event.currentTarget.getBoundingClientRect(),
                ),
              )
            }
            onPointerLeave={(event) => {
              if (event.pointerType === "mouse") setHover(null);
            }}
            onPointerDown={(event) => {
              const i = pick(
                event.clientX,
                event.currentTarget.getBoundingClientRect(),
              );
              setSelected(i);
              setHover(i);
            }}
            onKeyDown={(event) => {
              if (points.length === 0) return;
              const current =
                selected ?? (event.key === "ArrowLeft" ? points.length : -1);
              const next =
                event.key === "ArrowRight"
                  ? Math.min(points.length - 1, current + 1)
                  : event.key === "ArrowLeft"
                    ? Math.max(0, current - 1)
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? points.length - 1
                        : event.key === "Escape"
                          ? null
                          : undefined;
              if (next === undefined) return;
              event.preventDefault();
              setHover(null);
              setSelected(next);
            }}
          >
            <defs>
              <clipPath id={`${clip}-up`}>
                <rect x={0} y={0} width={width} height={y(baseline)} />
              </clipPath>
              <clipPath id={`${clip}-down`}>
                <rect
                  x={0}
                  y={y(baseline)}
                  width={width}
                  height={height - y(baseline)}
                />
              </clipPath>
              <linearGradient
                id={`${clip}-fill-up`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={colors.up} stopOpacity={0.28} />
                <stop offset="100%" stopColor={colors.up} stopOpacity={0.03} />
              </linearGradient>
              <linearGradient
                id={`${clip}-fill-down`}
                x1="0"
                y1="1"
                x2="0"
                y2="0"
              >
                <stop offset="0%" stopColor={colors.down} stopOpacity={0.28} />
                <stop
                  offset="100%"
                  stopColor={colors.down}
                  stopOpacity={0.03}
                />
              </linearGradient>
            </defs>
            {yTicks.map((tick) => (
              <g key={tick}>
                <line
                  x1={margin.left}
                  x2={margin.left + plotW}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke={tick === baseline ? colors.zero : colors.grid}
                  strokeDasharray={tick === baseline ? "4 4" : undefined}
                />
                <text
                  x={margin.left - 8}
                  y={y(tick) + 4}
                  textAnchor="end"
                  fill={colors.text}
                  fontSize={11}
                  className="num"
                >
                  {axisFormat(tick)}
                </text>
              </g>
            ))}
            {xTicks.ticks.map((time) => (
              <g key={time}>
                <line
                  x1={x(time)}
                  x2={x(time)}
                  y1={margin.top}
                  y2={margin.top + plotH}
                  stroke={colors.grid}
                />
                <line
                  x1={x(time)}
                  x2={x(time)}
                  y1={margin.top + plotH}
                  y2={margin.top + plotH + 4}
                  stroke={colors.zero}
                />
                <text
                  x={x(time)}
                  y={height - 10}
                  textAnchor="middle"
                  fill={colors.text}
                  fontSize={11}
                >
                  {xTicks.daily ? israelShortDate(time) : israelDateTime(time)}
                </text>
              </g>
            ))}
            <line
              x1={margin.left}
              x2={margin.left + plotW}
              y1={margin.top + plotH}
              y2={margin.top + plotH}
              stroke={colors.zero}
            />
            <path
              d={area}
              fill={`url(#${clip}-fill-up)`}
              clipPath={`url(#${clip}-up)`}
            />
            <path
              d={area}
              fill={`url(#${clip}-fill-down)`}
              clipPath={`url(#${clip}-down)`}
            />
            <path
              d={line}
              fill="none"
              stroke={colors.up}
              strokeWidth={2.25}
              strokeLinejoin="round"
              strokeLinecap="round"
              clipPath={`url(#${clip}-up)`}
            />
            <path
              d={line}
              fill="none"
              stroke={colors.down}
              strokeWidth={2.25}
              strokeLinejoin="round"
              strokeLinecap="round"
              clipPath={`url(#${clip}-down)`}
            />
            {active && (
              <g pointerEvents="none">
                <line
                  x1={x(active.time)}
                  x2={x(active.time)}
                  y1={margin.top}
                  y2={margin.top + plotH}
                  stroke={colors.crosshair}
                  strokeOpacity={0.45}
                  strokeDasharray="3 3"
                />
                <line
                  x1={margin.left}
                  x2={margin.left + plotW}
                  y1={y(value(active))}
                  y2={y(value(active))}
                  stroke={colors.crosshair}
                  strokeOpacity={0.25}
                  strokeDasharray="3 3"
                />
              </g>
            )}
            {points.map((p, i) => (
              <circle
                key={`${p.trade.symbol}:${p.trade.openedAt}:${p.trade.closedAt}`}
                cx={x(p.time)}
                cy={y(value(p))}
                r={shown === i ? 6 : points.length > 60 ? 2.5 : 3.5}
                fill={tone(p.trade.pnl)}
                stroke="#fff"
                strokeWidth={1.5}
                pointerEvents="none"
              >
                <title>{describe(p)}</title>
              </circle>
            ))}
          </svg>
        )}
        {active && (
          <div
            className="trade-pnl-tooltip"
            role="status"
            style={{
              left: Math.min(Math.max(tooltipLeft, 90), width - 90),
              top: tooltipTop,
              transform:
                tooltipTop < 110
                  ? "translate(-50%, 14px)"
                  : "translate(-50%, calc(-100% - 14px))",
            }}
          >
            <strong>{active.trade.symbol}</strong>
            <span className="muted">
              {israelDateTime(active.time)} {israelLabel}
            </span>
            <span>
              Trade{" "}
              <b className="num" style={{ color: tone(active.trade.pnl) }}>
                {format(tradeValue(active))}
              </b>
            </span>
            <span>
              Cumulative{" "}
              <b className="num" style={{ color: tone(value(active)) }}>
                {format(value(active))}
              </b>
            </span>
          </div>
        )}
      </div>
      <p className="muted">
        {pctAvailable
          ? "% = cumulative realized P&L ÷ account value at the start of the period. Hover, tap or use ← → to inspect trades."
          : "Percentage unavailable: starting account value is missing. Hover, tap or use ← → to inspect trades."}
      </p>
    </section>
  );
}
