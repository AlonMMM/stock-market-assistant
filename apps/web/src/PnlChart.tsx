import { useId, useState } from "react";
import type { PortfolioHistory } from "../../../packages/trading/src/portfolio.js";
import { cumulativeTrades } from "./trade-history-model.js";
import { israelDateTime, israelLabel } from "./time.js";

const money = (n: number) =>
  `${n < 0 ? "−" : n > 0 ? "+" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const percent = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;

/** Realized P&L through each close, placed at its actual closing timestamp. */
export function PnlChart({ history }: { history: PortfolioHistory }) {
  const [unit, setUnit] = useState<"usd" | "pct">("usd");
  const [selected, setSelected] = useState<string | null>(null);
  const clip = useId();
  const points = cumulativeTrades(history.trades, history.baseEquity);
  const pctAvailable = history.baseEquity !== null && history.baseEquity > 0;
  const showPct = unit === "pct" && pctAvailable;
  const format = showPct ? percent : money;
  const value = (p: (typeof points)[number]) => (showPct ? p.pct! : p.pnl);
  const key = (p: (typeof points)[number]) =>
    `${p.trade.symbol}:${p.trade.openedAt}:${p.trade.closedAt}`;
  const active = points.find((p) => key(p) === selected);
  const low = Math.min(0, ...points.map(value));
  const high = Math.max(0, ...points.map(value));
  const padding = Math.max((high - low) * 0.15, showPct ? 0.01 : 1);
  const min = low - padding;
  const max = high + padding;
  const start = Math.min(
    Date.parse(history.from),
    ...points.map((p) => p.time),
  );
  const end = Math.max(
    Date.parse(history.at),
    start + 1,
    ...points.map((p) => p.time),
  );
  const x = (time: number) => 76 + ((time - start) / (end - start)) * 306;
  const y = (pnl: number) => 20 + ((max - pnl) / (max - min)) * 194;
  const line = `M ${x(start)} ${y(0)} ${points.map((p) => `L ${x(p.time)} ${y(value(p))}`).join(" ")}`;
  const ticks = [low, (low + high) / 2, high, 0].filter(
    (n, i, all) => all.indexOf(n) === i,
  );
  const describe = (p: (typeof points)[number]) =>
    `${p.trade.symbol} · ${israelDateTime(p.time)} ${israelLabel} · Trade: ${money(p.trade.pnl)} · Cumulative: ${format(value(p))}`;
  return (
    <section
      className="trade-pnl-chart"
      aria-label="Cumulative realized profit and loss over time"
    >
      <div className="toolbar">
        <strong>Cumulative realized P&amp;L</strong>
        <div className="segmented" role="group" aria-label="Chart units">
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
      <p className="muted">One point per closed trade · {israelLabel}</p>
      <div className="trade-pnl-scroll">
        <svg
          viewBox="0 0 400 266"
          width="100%"
          role="group"
          aria-label={`Cumulative realized P&L in ${showPct ? "percent" : "dollars"} by closing time`}
        >
          <defs>
            <clipPath id={`${clip}-up`}>
              <rect x={76} y={0} width={312} height={y(0)} />
            </clipPath>
            <clipPath id={`${clip}-down`}>
              <rect x={76} y={y(0)} width={312} height={230 - y(0)} />
            </clipPath>
          </defs>
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={76}
                x2={382}
                y1={y(tick)}
                y2={y(tick)}
                stroke={tick === 0 ? "#858b85" : "#e7ece6"}
                strokeDasharray={tick === 0 ? "4 4" : undefined}
              />
              <text
                x={68}
                y={y(tick) + 4}
                textAnchor="end"
                fill="#52514e"
                fontSize={11}
              >
                {format(tick)}
              </text>
            </g>
          ))}
          <path
            d={line}
            fill="none"
            stroke="#16a34a"
            strokeWidth={2}
            clipPath={`url(#${clip}-up)`}
          />
          <path
            d={line}
            fill="none"
            stroke="#dc2626"
            strokeWidth={2}
            clipPath={`url(#${clip}-down)`}
          />
          {points.map((p) => (
            <g
              key={key(p)}
              role="button"
              tabIndex={0}
              aria-label={describe(p)}
              aria-pressed={selected === key(p)}
              onClick={() => setSelected(key(p))}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelected(key(p));
                }
              }}
              className="trade-pnl-dot"
            >
              <title>{describe(p)}</title>
              <circle
                cx={x(p.time)}
                cy={y(value(p))}
                r={7}
                fill="transparent"
              />
              <circle
                cx={x(p.time)}
                cy={y(value(p))}
                r={selected === key(p) ? 5 : 3}
                fill={
                  value(p) > 0
                    ? "#16a34a"
                    : value(p) < 0
                      ? "#dc2626"
                      : "#64748b"
                }
                stroke="#fff"
                strokeWidth={1}
              />
            </g>
          ))}
          {[start, (start + end) / 2, end].map((time, i) => (
            <text
              key={i}
              x={x(time)}
              y={237}
              textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
              fill="#52514e"
              fontSize={10}
            >
              {israelDateTime(time)}
            </text>
          ))}
        </svg>
      </div>
      <p className="muted">
        {pctAvailable
          ? "% = cumulative realized P&L ÷ account value at the start of the period."
          : "Percentage unavailable: starting account value is missing."}
      </p>
      <p className="trade-pnl-detail" aria-live="polite">
        {active
          ? describe(active)
          : "Tap a point to see the trade and cumulative result."}
      </p>
    </section>
  );
}
