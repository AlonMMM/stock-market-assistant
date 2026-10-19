import { lazy, Suspense } from "react";

// A stock's day chart: the one chart (ChartPanel), which switches between
// candles and the comparison with SPY itself (user 2026-10-19).

const ChartPanel = lazy(() =>
  import("./ChartPanel.js").then((m) => ({ default: m.ChartPanel })),
);

export function StockChart({ ticker, date }: { ticker: string; date: string }) {
  return (
    <div className="stock-chart">
      <Suspense fallback={<p className="chart-status">Loading chart…</p>}>
        <ChartPanel ticker={ticker} date={date} />
      </Suspense>
    </div>
  );
}
