import { useEffect, useRef } from "react";
import {
  BaselineSeries,
  ColorType,
  createChart,
  CrosshairMode,
} from "lightweight-charts";
import type { PortfolioHistory } from "../../../packages/trading/src/portfolio.js";

const colors = {
  surface: "#fafbf8",
  text: "#52514e",
  grid: "#e7ece6",
  up: "#16a34a",
  down: "#dc2626",
};
const money = (n: number) =>
  `${n < 0 ? "−" : n > 0 ? "+" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/** Profit and loss since the start of the period, one point per trading day. */
export function PnlChart({ points }: { points: PortfolioHistory["points"] }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current || points.length === 0) return;
    const chart = createChart(host.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: colors.surface },
        textColor: colors.text,
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: colors.grid },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
      crosshair: { mode: CrosshairMode.Magnet },
      handleScroll: false,
      handleScale: false,
    });
    // Green above zero, red below: the line is the account's gain or loss.
    const series = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: 0 },
      lineWidth: 2,
      topLineColor: colors.up,
      topFillColor1: "rgba(22, 163, 74, 0.22)",
      topFillColor2: "rgba(22, 163, 74, 0.04)",
      bottomLineColor: colors.down,
      bottomFillColor1: "rgba(220, 38, 38, 0.04)",
      bottomFillColor2: "rgba(220, 38, 38, 0.22)",
      priceFormat: { type: "custom", formatter: money, minMove: 1 },
      priceLineVisible: false,
      // The period's total is in the tile above; a label here covers a tick.
      lastValueVisible: false,
    });
    series.setData(points.map((p) => ({ time: p.date, value: p.pnl })));
    series.createPriceLine({
      price: 0,
      color: colors.text,
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: false,
    });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points]);
  return (
    <div
      ref={host}
      className="pnl-chart"
      role="img"
      aria-label="Profit and loss over the period"
    />
  );
}
