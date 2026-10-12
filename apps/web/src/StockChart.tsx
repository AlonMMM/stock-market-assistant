import { lazy, Suspense, useState } from "react";

// A stock's day chart in one of two forms: plain candles, or the comparison
// with SPY. The choice is remembered on this device.

const CandleChart = lazy(() =>
  import("./CandleChart.js").then((m) => ({ default: m.CandleChart })),
);
const DayChart = lazy(() =>
  import("./DayChart.js").then((m) => ({ default: m.DayChart })),
);

type Kind = "candles" | "spy";
const key = "sma.chart-kind.v1";
function saved(): Kind {
  try {
    return localStorage.getItem(key) === "spy" ? "spy" : "candles";
  } catch {
    return "candles";
  }
}

export function StockChart({ ticker, date }: { ticker: string; date: string }) {
  const [kind, setKindState] = useState<Kind>(saved);
  const setKind = (next: Kind) => {
    setKindState(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      // Remembered for this visit only.
    }
  };
  return (
    <div className="stock-chart">
      <div className="segmented" role="group" aria-label="Chart type">
        <button
          type="button"
          aria-pressed={kind === "candles"}
          onClick={() => setKind("candles")}
        >
          Candles
        </button>
        <button
          type="button"
          aria-pressed={kind === "spy"}
          onClick={() => setKind("spy")}
        >
          vs SPY
        </button>
      </div>
      <Suspense fallback={<p className="chart-status">Loading chart…</p>}>
        {kind === "candles" ? (
          <CandleChart ticker={ticker} date={date} />
        ) : (
          <DayChart ticker={ticker} date={date} />
        )}
      </Suspense>
    </div>
  );
}
