import { useEffect, useId, useRef, useState } from "react";
import type { PortfolioHistory } from "../../../packages/trading/src/portfolio.js";
import { cumulativeTrades, niceTicks } from "./trade-history-model.js";
import { israelDateTime, israelLabel, israelShortDate } from "./time.js";

// The account's realized value as an equity curve, like a broker's (user
// 2026-10-19: "make this graph look more professional"): a step at each
// closed trade, the trades evenly spaced so nights and weekends take no room,
// and each trade's result as a bar underneath.

const colors = {
  up: "#16a34a",
  down: "#dc2626",
  flat: "#64748b",
  base: "#8b938c",
  grid: "#e9ede8",
  day: "#d9dfd7",
  text: "#5c6460",
  crosshair: "#142b29",
};

const money = (n: number) =>
  `${n < 0 ? "−" : n > 0 ? "+" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const percent = (n: number) =>
  `${n < 0 ? "−" : n > 0 ? "+" : ""}${Math.abs(n).toFixed(2)}%`;
const axisMoney = (n: number) =>
  `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", {
    notation: Math.abs(n) >= 10000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(n) >= 100 ? 1 : 2,
  })}`;
const axisPercent = (n: number) =>
  `${n < 0 ? "−" : ""}${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
const tone = (n: number) =>
  n > 0 ? colors.up : n < 0 ? colors.down : colors.flat;

const margin = { top: 12, right: 64, bottom: 26, left: 12 };
const barsHeight = 64;
const gap = 14;

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

  const phone = width > 0 && width < 560;
  const curveHeight = phone ? 190 : 250;
  const height = margin.top + curveHeight + gap + barsHeight + margin.bottom;
  const plotW = Math.max(1, width - margin.left - margin.right);
  const n = Math.max(1, points.length);
  const slot = plotW / n;
  // Trade i closes at the end of its slot; the curve starts at the base.
  const xEnd = (i: number) => margin.left + (i + 1) * slot;
  const xMid = (i: number) => margin.left + (i + 0.5) * slot;

  const values = points.map(value);
  const low = Math.min(...values, baseline);
  const high = Math.max(...values, baseline);
  const pad = Math.max((high - low) * 0.1, showPct ? 0.05 : 5);
  // The scale hugs the data; round ticks inside it, none on the start line.
  const min = low - pad;
  const max = high + pad;
  const yTicks = niceTicks(min, max, phone ? 5 : 7).filter(
    (t) =>
      t >= min &&
      t <= max &&
      Math.abs(t - baseline) > ((max - min) / curveHeight) * 14,
  );
  const y = (v: number) => margin.top + ((max - v) / (max - min)) * curveHeight;

  const results = points.map(tradeValue);
  // One trade far bigger than the rest would flatten every other bar: the
  // scale follows the second biggest, and the big one is cut with a notch.
  const sizes = results.map(Math.abs).sort((a, b) => b - a);
  const biggest = Math.max(
    sizes.length > 2 && sizes[0]! > 3 * sizes[1]! ? sizes[1]! * 1.4 : sizes[0]!,
    1e-9,
  );
  const barsTop = margin.top + curveHeight + gap;
  const barsMid = barsTop + barsHeight / 2;
  const barY = (v: number) =>
    barsMid -
    (Math.max(-biggest, Math.min(biggest, v)) / biggest) * (barsHeight / 2 - 2);
  const barW = Math.max(1, Math.min(slot * 0.62, 14));

  // Steps: flat until a trade closes, then up or down to its value.
  let line = `M ${margin.left} ${y(baseline)}`;
  points.forEach((p, i) => {
    line += ` H ${xEnd(i)} V ${y(value(p))}`;
  });
  if (points.length) line += ` H ${margin.left + plotW}`;
  const area = `${line} V ${y(baseline)} H ${margin.left} Z`;

  // A label for each day's first trade, where there is room for it.
  const days: { at: number; label: string }[] = [];
  let lastLabelX = -Infinity;
  points.forEach((p, i) => {
    const label = israelShortDate(p.time);
    if (i > 0 && israelShortDate(points[i - 1]!.time) === label) return;
    const at = margin.left + i * slot;
    days.push({ at, label: at - lastLabelX >= 54 ? label : "" });
    if (at - lastLabelX >= 54) lastLabelX = at;
  });

  const shown = hover ?? selected;
  const active = shown !== null ? points[shown] : undefined;
  const last = points.at(-1);
  const pick = (clientX: number, rect: DOMRect) => {
    if (!points.length) return null;
    const i = Math.floor((clientX - rect.left - margin.left) / slot);
    return Math.min(points.length - 1, Math.max(0, i));
  };

  const wins = history.trades.filter((t) => t.pnl > 0).length;
  const best = Math.max(...history.trades.map((t) => t.pnl), 0);
  const worst = Math.min(...history.trades.map((t) => t.pnl), 0);
  const change = last ? last.pnl : 0;
  const changePct = last?.pct ?? null;
  const tooltipLeft = active ? xMid(shown!) : 0;

  return (
    <section
      className="trade-pnl-chart"
      aria-label={
        equityChart
          ? "Realized account value by closed trade"
          : "Cumulative realized profit and loss by closed trade"
      }
    >
      <div className="toolbar">
        <div className="trade-pnl-heading">
          <span className="trade-pnl-title">
            {showPct
              ? "Realized return"
              : equityChart
                ? "Realized account value"
                : "Realized P&L"}
          </span>
          {last && (
            <strong className="trade-pnl-total num">
              {showPct || !equityChart
                ? format(value(last))
                : `$${value(last).toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
            </strong>
          )}
          {last && (
            <span
              className="trade-pnl-change num"
              style={{ color: tone(change) }}
            >
              {money(change)}
              {changePct !== null && ` (${percent(changePct)})`}
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
      {points.length > 0 && (
        <dl className="trade-pnl-stats num">
          <div>
            <dt>Trades</dt>
            <dd>{points.length}</dd>
          </div>
          <div>
            <dt>Win rate</dt>
            <dd>{Math.round((wins / points.length) * 100)}%</dd>
          </div>
          <div>
            <dt>Best</dt>
            <dd style={{ color: tone(best) }}>{money(best)}</dd>
          </div>
          <div>
            <dt>Worst</dt>
            <dd style={{ color: tone(worst) }}>{money(worst)}</dd>
          </div>
        </dl>
      )}
      <div className="trade-pnl-frame" ref={frame}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`${equityChart ? "Realized account value" : "Realized P&L"} after each closed trade, in ${showPct ? "percent" : "dollars"}, with each trade's result below`}
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
                  height={Math.max(0, barsTop - y(baseline))}
                />
              </clipPath>
              <linearGradient
                id={`${clip}-up-fill`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={colors.up} stopOpacity={0.18} />
                <stop offset="100%" stopColor={colors.up} stopOpacity={0.02} />
              </linearGradient>
              <linearGradient
                id={`${clip}-down-fill`}
                x1="0"
                y1="1"
                x2="0"
                y2="0"
              >
                <stop offset="0%" stopColor={colors.down} stopOpacity={0.18} />
                <stop
                  offset="100%"
                  stopColor={colors.down}
                  stopOpacity={0.02}
                />
              </linearGradient>
            </defs>

            {/* Value axis on the right, as in trading apps. */}
            {yTicks.map((tick) => (
              <g key={tick}>
                <line
                  x1={margin.left}
                  x2={margin.left + plotW}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke={colors.grid}
                />
                <text
                  x={margin.left + plotW + 8}
                  y={y(tick) + 4}
                  fill={colors.text}
                  fontSize={11}
                >
                  {axisFormat(tick)}
                </text>
              </g>
            ))}
            {/* Where each day's trades begin. */}
            {days.map((d, i) => (
              <g key={`${d.at}-${i}`}>
                {i > 0 && (
                  <line
                    x1={d.at}
                    x2={d.at}
                    y1={margin.top}
                    y2={barsTop + barsHeight}
                    stroke={colors.day}
                    strokeDasharray="2 3"
                  />
                )}
                {d.label && (
                  <text
                    x={d.at + 4}
                    y={height - 8}
                    fill={colors.text}
                    fontSize={11}
                  >
                    {d.label}
                  </text>
                )}
              </g>
            ))}
            {/* The start: the account's value before the period's trades. */}
            <line
              x1={margin.left}
              x2={margin.left + plotW}
              y1={y(baseline)}
              y2={y(baseline)}
              stroke={colors.base}
              strokeDasharray="4 4"
            />
            <text
              x={margin.left + plotW + 8}
              y={y(baseline) + 4}
              fill={colors.base}
              fontSize={11}
              fontWeight={600}
            >
              {axisFormat(baseline)}
            </text>

            <path
              d={area}
              fill={`url(#${clip}-up-fill)`}
              clipPath={`url(#${clip}-up)`}
            />
            <path
              d={area}
              fill={`url(#${clip}-down-fill)`}
              clipPath={`url(#${clip}-down)`}
            />
            <path
              d={line}
              fill="none"
              stroke={colors.up}
              strokeWidth={2}
              strokeLinejoin="miter"
              clipPath={`url(#${clip}-up)`}
            />
            <path
              d={line}
              fill="none"
              stroke={colors.down}
              strokeWidth={2}
              strokeLinejoin="miter"
              clipPath={`url(#${clip}-down)`}
            />
            {last && (
              <circle
                cx={xEnd(points.length - 1)}
                cy={y(value(last))}
                r={3.5}
                fill={tone(value(last) - baseline)}
                stroke="#fff"
                strokeWidth={1.5}
              />
            )}

            {/* Each trade's result. */}
            <line
              x1={margin.left}
              x2={margin.left + plotW}
              y1={barsMid}
              y2={barsMid}
              stroke={colors.base}
              strokeOpacity={0.6}
            />
            <text
              x={margin.left + plotW + 8}
              y={barsTop + 10}
              fill={colors.text}
              fontSize={10}
            >
              per trade
            </text>
            {points.map((p, i) => {
              const v = tradeValue(p);
              const top = Math.min(barY(v), barsMid);
              const cut = Math.abs(v) > biggest;
              return (
                <g
                  key={`${p.trade.symbol}:${p.trade.openedAt}:${p.trade.closedAt}`}
                >
                  <rect
                    x={xMid(i) - barW / 2}
                    y={top}
                    width={barW}
                    height={Math.max(1, Math.abs(barY(v) - barsMid))}
                    rx={Math.min(2, barW / 3)}
                    fill={tone(v)}
                    fillOpacity={shown === null || shown === i ? 0.9 : 0.35}
                  />
                  {cut && (
                    <line
                      x1={xMid(i) - barW / 2 - 1}
                      x2={xMid(i) + barW / 2 + 1}
                      y1={
                        v > 0 ? top + 5 : top + Math.abs(barY(v) - barsMid) - 5
                      }
                      y2={
                        v > 0 ? top + 2 : top + Math.abs(barY(v) - barsMid) - 8
                      }
                      stroke="#fff"
                      strokeWidth={2}
                    />
                  )}
                </g>
              );
            })}

            {active && (
              <g pointerEvents="none">
                <line
                  x1={xMid(shown!)}
                  x2={xMid(shown!)}
                  y1={margin.top}
                  y2={barsTop + barsHeight}
                  stroke={colors.crosshair}
                  strokeOpacity={0.35}
                  strokeDasharray="3 3"
                />
                <circle
                  cx={xEnd(shown!)}
                  cy={y(value(active))}
                  r={5}
                  fill={tone(value(active) - baseline)}
                  stroke="#fff"
                  strokeWidth={2}
                />
              </g>
            )}
          </svg>
        )}
        {active && (
          <div
            className="trade-pnl-tooltip"
            role="status"
            style={{
              left: Math.min(Math.max(tooltipLeft, 96), width - 96),
              top: margin.top + 4,
              transform: "translateX(-50%)",
            }}
          >
            <strong>
              {active.trade.underlying}{" "}
              {active.trade.option
                ? `${active.trade.option.strike} ${active.trade.option.right === "call" ? "Call" : "Put"}`
                : "shares"}
            </strong>
            <span className="muted">
              Closed {israelDateTime(active.time)} {israelLabel}
            </span>
            <span>
              This trade{" "}
              <b className="num" style={{ color: tone(active.trade.pnl) }}>
                {format(tradeValue(active))}
              </b>
            </span>
            <span>
              {equityChart && !showPct ? "Account" : "Total"}{" "}
              <b className="num">
                {showPct || !equityChart
                  ? format(value(active))
                  : `$${value(active).toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
              </b>
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
