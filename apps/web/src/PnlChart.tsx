import { useId, useState } from "react";
import type { PortfolioHistory } from "../../../packages/trading/src/portfolio.js";
import {
  cumulativeTrades,
  dayLabels,
  nearestPoint,
} from "./trade-history-model.js";
import { useDark } from "./theme.js";
import { israelDateTime, israelLabel } from "./time.js";
import { useWidth } from "./use-width.js";

// The realized account value as one calm line (user 2026-10-26, option A of
// the chart options): a big number and its change lead, the line runs from
// the starting value through each closed trade, evenly spaced so weekends
// leave no gaps, with no grid, no axis numbers and no dots but the last.
// Dragging across it shows each trade's value in the header.

const lightColors = {
  up: "#0e7a43",
  down: "#b42318",
  flat: "#5d6e69",
  start: "#9aa59f",
  muted: "#5d6e69",
  crosshair: "#142b29",
  ring: "#fff", // around the dot, the card's colour
};
// The dark theme's pairs (user 2026-10-27: dark mode for the whole app).
const darkColors: typeof lightColors = {
  up: "#3fcf7f",
  down: "#ff5c5c",
  flat: "#8d95a1",
  start: "#5d6672",
  muted: "#99a0ab",
  crosshair: "#e6e8eb",
  ring: "#1b1e24",
};

const usd = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const signedUsd = (n: number) =>
  `${n < 0 ? "−" : n > 0 ? "+" : ""}${usd(Math.round(n))}`;
const signedPct = (n: number) =>
  `${n < 0 ? "−" : n > 0 ? "+" : ""}${Math.abs(n).toFixed(2)}%`;
const toneIn = (colors: typeof lightColors, n: number) =>
  n > 0 ? colors.up : n < 0 ? colors.down : colors.flat;

const pad = { top: 26, right: 10, bottom: 26, left: 10 };

export function PnlChart({
  history,
  periodLabel,
}: {
  // The account's closed trades and its value at the start (a backtest's too).
  history: Pick<PortfolioHistory, "trades" | "baseEquity">;
  // The period chosen above the chart, in words ("month").
  periodLabel?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const colors = useDark() ? darkColors : lightColors;
  const tone = (n: number) => toneIn(colors, n);
  const [frame, width] = useWidth<HTMLDivElement>();
  const gradient = useId().replace(/:/g, "");
  const points = cumulativeTrades(history.trades, history.baseEquity);
  const base = history.baseEquity;
  const equity = base !== null;
  const last = points.at(-1);
  const total = last?.pnl ?? 0;
  const value = (pnl: number) => (equity ? base! + pnl : pnl);
  const color = tone(total);

  const height = width > 0 && width < 520 ? 200 : 240;
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  // The start, then one step per closed trade.
  const values = [value(0), ...points.map((p) => value(p.pnl))];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const room = Math.max((hi - lo) * 0.1, equity ? base! * 0.0005 : 1);
  const min = lo - room;
  const max = hi + room;
  const x = (i: number) =>
    pad.left + (values.length > 1 ? (i / (values.length - 1)) * plotW : plotW);
  const y = (v: number) => pad.top + ((max - v) / (max - min)) * plotH;
  const coords = values.map((v, i) => [x(i), y(v)] as const);
  const line = coords
    .map(([cx, cy], i) => `${i === 0 ? "M" : "L"} ${cx} ${cy}`)
    .join(" ");
  const area = `${line} L ${x(values.length - 1)} ${pad.top + plotH} L ${x(0)} ${pad.top + plotH} Z`;
  const labels = dayLabels(
    points.map((_, i) => x(i + 1)),
    points.map((p) => p.time),
    width,
  );

  const shown = active !== null ? points[active] : undefined;
  const headValue = shown ? value(shown.pnl) : value(total);
  const pick = (clientX: number, rect: DOMRect) => {
    const i = nearestPoint(
      points.map((_, k) => x(k + 1)),
      clientX - rect.left,
    );
    return i < 0 ? null : i;
  };
  const changeText = (pnl: number) =>
    `${signedUsd(pnl)}${equity && base! > 0 ? ` (${signedPct((pnl / base!) * 100)})` : ""}`;

  return (
    <section
      className="pnl-card"
      aria-label={
        equity ? "Realized account value" : "Realized profit and loss"
      }
    >
      <div className="pnl-head">
        <span className="pnl-label">
          {equity ? "Realized account value" : "Realized P&L"}
        </span>
        <strong className="pnl-value num">
          {equity ? usd(headValue) : signedUsd(headValue)}
        </strong>
        <span className="pnl-sub num" aria-live="polite">
          {shown ? (
            <>
              <b style={{ color: tone(shown.trade.pnl) }}>
                {shown.trade.underlying ?? shown.trade.symbol}{" "}
                {signedUsd(shown.trade.pnl)}
              </b>{" "}
              · {israelDateTime(shown.time)} {israelLabel}
            </>
          ) : (
            <>
              <b style={{ color }}>{changeText(total)}</b>
              {periodLabel ? ` · ${periodLabel}` : ""} · {points.length} trade
              {points.length === 1 ? "" : "s"}
            </>
          )}
        </span>
      </div>
      <div className="pnl-frame" ref={frame}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`${equity ? "Account value" : "Realized P&L"} from ${equity ? usd(base!) : "$0"} to ${equity ? usd(value(total)) : signedUsd(total)} over ${points.length} closed trades`}
            tabIndex={0}
            className="pnl-svg"
            onPointerMove={(e) =>
              setActive(
                pick(e.clientX, e.currentTarget.getBoundingClientRect()),
              )
            }
            onPointerDown={(e) =>
              setActive(
                pick(e.clientX, e.currentTarget.getBoundingClientRect()),
              )
            }
            onPointerLeave={(e) => {
              if (e.pointerType === "mouse") setActive(null);
            }}
            onKeyDown={(e) => {
              const end = points.length - 1;
              if (end < 0) return;
              const next =
                e.key === "ArrowLeft"
                  ? active === null
                    ? end
                    : Math.max(0, active - 1)
                  : e.key === "ArrowRight"
                    ? active === null
                      ? end
                      : Math.min(end, active + 1)
                    : e.key === "Home"
                      ? 0
                      : e.key === "End"
                        ? end
                        : e.key === "Escape"
                          ? null
                          : undefined;
              if (next === undefined) return;
              e.preventDefault();
              setActive(next);
            }}
          >
            <defs>
              <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.16} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            {/* The starting value, dashed and named. */}
            <line
              x1={0}
              x2={width}
              y1={y(values[0]!)}
              y2={y(values[0]!)}
              stroke={colors.start}
              strokeDasharray="3 4"
            />
            <text
              x={width - 2}
              y={y(values[0]!) - 6}
              textAnchor="end"
              fontSize={11}
              fill={colors.muted}
            >
              start {equity ? usd(base!) : "$0"}
            </text>
            <path d={area} fill={`url(#${gradient})`} />
            <path
              d={line}
              fill="none"
              stroke={color}
              strokeWidth={2.25}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {active !== null && (
              <line
                x1={x(active + 1)}
                x2={x(active + 1)}
                y1={pad.top - 8}
                y2={pad.top + plotH}
                stroke={colors.crosshair}
                strokeOpacity={0.35}
              />
            )}
            {(() => {
              const i = active !== null ? active + 1 : values.length - 1;
              const dot = tone(
                active !== null ? points[active]!.trade.pnl : total,
              );
              return (
                <circle
                  cx={x(i)}
                  cy={y(values[i]!)}
                  r={active !== null ? 5 : 4}
                  fill={dot}
                  stroke={colors.ring}
                  strokeWidth={2}
                />
              );
            })()}
            {labels.map((l) => (
              <text
                key={l.text}
                x={l.x}
                y={height - 6}
                textAnchor={l.anchor}
                fontSize={11}
                fill={colors.muted}
              >
                {l.text}
              </text>
            ))}
          </svg>
        )}
      </div>
    </section>
  );
}
