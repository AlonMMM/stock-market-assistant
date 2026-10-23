import { useEffect, useId, useRef, useState } from "react";
import type { PortfolioHistory } from "../../../packages/trading/src/portfolio.js";
import {
  cumulativeTrades,
  dailyCloses,
  niceTicks,
} from "./trade-history-model.js";
import { israelShortDate } from "./time.js";

// The realized account value (user 2026-10-20, option A of the design
// canvas): one point per day with closed trades, joined by a clean line over
// a soft area, the starting value dashed, values on the right. Green when the
// period is up, red when it is down.

const colors = {
  up: "#1d6b3a",
  down: "#b42318",
  base: "#9aa5a1",
  grid: "#eef1ec",
  text: "#6b7a76",
};

const money = (n: number) =>
  `${n < 0 ? "−" : n > 0 ? "+" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const percent = (n: number) =>
  `${n < 0 ? "−" : n > 0 ? "+" : ""}${Math.abs(n).toFixed(2)}%`;
const axisMoney = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", {
    notation: Math.abs(n) >= 10000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(n) >= 10000 ? 1 : 0,
  })}`;
const axisPercent = (n: number) =>
  `${n < 0 ? "−" : n > 0 ? "+" : ""}${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
const dollars = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const margin = { top: 10, right: 60, bottom: 26, left: 4 };

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

export function PnlChart({ history }: { history: PortfolioHistory }) {
  const [unit, setUnit] = useState<"usd" | "pct">("usd");
  const [hover, setHover] = useState<number | null>(null);
  const [frame, width] = useWidth<HTMLDivElement>();
  const fill = useId().replace(/:/g, "");
  const days = dailyCloses(
    cumulativeTrades(history.trades, history.baseEquity),
  );
  const base = history.baseEquity;
  const pctAvailable = base !== null && base > 0;
  const showPct = unit === "pct" && pctAvailable;
  // In dollars: the account's value; without a base, the realized P&L.
  const valueOf = (pnl: number) =>
    showPct ? (pnl / base!) * 100 : base !== null ? base + pnl : pnl;
  const start = valueOf(0);
  // The start, then each day's close.
  const values = [start, ...days.map((d) => valueOf(d.pnl))];
  const total = days.at(-1)?.pnl ?? 0;
  const up = total >= 0;
  const color = up ? colors.up : colors.down;

  const height = width > 0 && width < 560 ? 220 : 280;
  const plotW = Math.max(1, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const pad = Math.max((high - low) * 0.12, showPct ? 0.05 : 50);
  const min = low - pad;
  const max = high + pad;
  const y = (v: number) => margin.top + ((max - v) / (max - min)) * plotH;
  const x = (i: number) =>
    margin.left + (values.length > 1 ? (i / (values.length - 1)) * plotW : 0);
  const ticks = niceTicks(min, max, 5).filter(
    (t) => t >= min && t <= max && Math.abs(y(t) - y(start)) > 14, // the start line has its own label
  );
  const line = values
    .map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
  const bottom = margin.top + plotH;
  const area = `${line} L${x(values.length - 1).toFixed(1)},${bottom} L${margin.left},${bottom} Z`;
  // Day labels where there is room (about 56px each).
  const every = Math.max(1, Math.ceil((days.length * 56) / plotW));

  // Hover: the nearest day (index into `days`).
  const pick = (clientX: number, rect: DOMRect) => {
    if (!days.length) return null;
    const i = Math.round(
      ((clientX - rect.left - margin.left) / plotW) * (values.length - 1),
    );
    return Math.min(days.length - 1, Math.max(0, i - 1));
  };
  const active = hover !== null ? days[hover] : undefined;
  const ax = hover !== null ? x(hover + 1) : 0;

  return (
    <section
      className="trade-pnl-chart"
      aria-label="Realized account value at the end of each day with closed trades"
    >
      <div className="pnl-head">
        <div className="pnl-figures">
          <span className="pnl-label">
            {showPct
              ? "Realized return"
              : base !== null
                ? "Realized account value"
                : "Realized P&L"}
          </span>
          <strong className="pnl-value num">
            {showPct
              ? percent(valueOf(total))
              : base !== null
                ? dollars(valueOf(total))
                : money(total)}
          </strong>
          <span className="pnl-change num" style={{ color }}>
            {money(total)}
            {pctAvailable && ` (${percent((total / base!) * 100)})`}
            <span className="muted"> in this period</span>
          </span>
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
      <div className="pnl-frame" ref={frame}>
        {width > 0 && days.length > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`From ${showPct ? "0%" : dollars(start)} to ${showPct ? percent(valueOf(total)) : dollars(valueOf(total))} over ${days.length} trading day${days.length === 1 ? "" : "s"}`}
            className="pnl-svg"
            onPointerMove={(e) =>
              setHover(pick(e.clientX, e.currentTarget.getBoundingClientRect()))
            }
            onPointerDown={(e) =>
              setHover(pick(e.clientX, e.currentTarget.getBoundingClientRect()))
            }
            onPointerLeave={(e) => {
              if (e.pointerType === "mouse") setHover(null);
            }}
          >
            <defs>
              <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.16} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={margin.left}
                  x2={margin.left + plotW}
                  y1={y(t)}
                  y2={y(t)}
                  stroke={colors.grid}
                />
                <text
                  x={margin.left + plotW + 10}
                  y={y(t) + 4}
                  fontSize={11}
                  fill={colors.text}
                  className="num"
                >
                  {showPct ? axisPercent(t) : axisMoney(t)}
                </text>
              </g>
            ))}
            <line
              x1={margin.left}
              x2={margin.left + plotW}
              y1={y(start)}
              y2={y(start)}
              stroke={colors.base}
              strokeDasharray="3 4"
            />
            <text
              x={margin.left + plotW + 10}
              y={y(start) + 4}
              fontSize={11}
              fontWeight={600}
              fill={colors.text}
              className="num"
            >
              {showPct ? "0%" : axisMoney(start)}
            </text>
            <path d={area} fill={`url(#${fill})`} />
            <path
              d={line}
              fill="none"
              stroke={color}
              strokeWidth={2.2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {days.map(
              (d, i) =>
                (i === days.length - 1 ||
                  (i % every === 0 && x(days.length) - x(i + 1) >= 56)) && (
                  <text
                    key={d.day}
                    x={x(i + 1)}
                    y={height - 8}
                    fontSize={11}
                    fill={colors.text}
                    textAnchor={i === days.length - 1 ? "end" : "middle"}
                  >
                    {israelShortDate(d.time)}
                  </text>
                ),
            )}
            {active ? (
              <g pointerEvents="none">
                <line
                  x1={ax}
                  x2={ax}
                  y1={margin.top}
                  y2={bottom}
                  stroke="#142b29"
                  strokeOpacity={0.25}
                />
                <circle
                  cx={ax}
                  cy={y(valueOf(active.pnl))}
                  r={4.5}
                  fill={color}
                  stroke="#fff"
                  strokeWidth={2}
                />
              </g>
            ) : (
              <circle
                cx={x(values.length - 1)}
                cy={y(values.at(-1)!)}
                r={4}
                fill={color}
                stroke="#fff"
                strokeWidth={2}
              />
            )}
          </svg>
        )}
        {days.length === 0 && (
          <p className="chart-status">No closed trades in this period.</p>
        )}
        {active && (
          <div
            className="pnl-tip"
            role="status"
            style={{
              left: Math.min(Math.max(ax, 80), width - 80),
            }}
          >
            <strong>{israelShortDate(active.time)}</strong>
            <span className="num">
              {showPct
                ? percent(valueOf(active.pnl))
                : base !== null
                  ? dollars(valueOf(active.pnl))
                  : money(active.pnl)}
            </span>
            <span
              className="num"
              style={{ color: active.dayPnl >= 0 ? colors.up : colors.down }}
            >
              {money(active.dayPnl)} that day · {active.trades} trade
              {active.trades === 1 ? "" : "s"}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
