import { useState } from "react";
import type { ClosedTrade } from "../../../packages/trading/src/portfolio.js";
import { israelDateTime, israelLabel } from "./time.js";

const money = (n: number) =>
  `${n < 0 ? "−" : n > 0 ? "+" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** One equally spaced dot per closed trade, including trades closed together. */
export function PnlChart({ trades }: { trades: ClosedTrade[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const ordered = [...trades].sort(
    (a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt),
  );
  const key = (t: ClosedTrade) => `${t.symbol}:${t.openedAt}:${t.closedAt}`;
  const active = ordered.find((t) => key(t) === selected);
  const low = Math.min(0, ...ordered.map((t) => t.pnl));
  const high = Math.max(0, ...ordered.map((t) => t.pnl));
  const padding = Math.max((high - low) * 0.15, 1);
  const min = low - padding;
  const max = high + padding;
  const width = Math.max(340, ordered.length * 36 + 100);
  const x = (i: number) =>
    ordered.length === 1
      ? (width + 60) / 2
      : 88 + (i / (ordered.length - 1)) * (width - 112);
  const y = (pnl: number) => 22 + ((max - pnl) / (max - min)) * 200;
  const describe = (t: ClosedTrade, i: number) =>
    `Trade ${i + 1}: ${t.symbol} · ${money(t.pnl)}${t.pnlPct === null ? "" : ` (${t.pnlPct.toFixed(1)}%)`} · ${israelDateTime(Date.parse(t.closedAt))} ${israelLabel}`;
  const ticks = [low, (low + high) / 2, high, 0].filter(
    (value, i, values) => values.indexOf(value) === i,
  );
  return (
    <section
      className="trade-pnl-chart"
      aria-label="Profit and loss per closed trade"
    >
      <strong>Closed-trade P&amp;L</strong>
      <p className="muted">Each dot is one trade · oldest to newest</p>
      <div className="trade-pnl-scroll">
        <svg
          width={width}
          height={266}
          role="group"
          aria-label="Trade results in dollars"
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={78}
                x2={width - 12}
                y1={y(tick)}
                y2={y(tick)}
                stroke={tick === 0 ? "#858b85" : "#e7ece6"}
                strokeDasharray={tick === 0 ? "4 4" : undefined}
              />
              <text
                x={70}
                y={y(tick) + 4}
                textAnchor="end"
                fill="#52514e"
                fontSize={11}
              >
                {money(tick)}
              </text>
            </g>
          ))}
          {ordered.map((trade, i) => (
            <g key={key(trade)}>
              <g
                role="button"
                tabIndex={0}
                aria-label={describe(trade, i)}
                aria-pressed={selected === key(trade)}
                onClick={() => setSelected(key(trade))}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelected(key(trade));
                  }
                }}
                className="trade-pnl-dot"
              >
                <title>{describe(trade, i)}</title>
                <circle cx={x(i)} cy={y(trade.pnl)} r={18} fill="transparent" />
                <circle
                  cx={x(i)}
                  cy={y(trade.pnl)}
                  r={selected === key(trade) ? 7 : 5}
                  fill={
                    trade.pnl > 0
                      ? "#16a34a"
                      : trade.pnl < 0
                        ? "#dc2626"
                        : "#64748b"
                  }
                  stroke={selected === key(trade) ? "#172b27" : "#fff"}
                  strokeWidth={2}
                />
              </g>
              <text
                x={x(i)}
                y={246}
                textAnchor="middle"
                fill="#52514e"
                fontSize={11}
              >
                {i + 1}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <p className="trade-pnl-detail" aria-live="polite">
        {active
          ? describe(active, ordered.indexOf(active))
          : "Tap a dot for the trade, result and closing time. Green = profit; red = loss."}
      </p>
    </section>
  );
}
