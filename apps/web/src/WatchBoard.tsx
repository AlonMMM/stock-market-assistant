import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type {
  Board,
  BoardSeries,
} from "../../../packages/market-data/src/board.js";
import { Sparkline } from "./Sparkline.js";

const DayChart = lazy(() =>
  import("./DayChart.js").then((m) => ({ default: m.DayChart })),
);

const signed = (n: number) => (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(2);

function change(s: BoardSeries): number | null {
  const last = s.points.at(-1)?.[1];
  return last !== undefined && s.previousClose
    ? (last / s.previousClose - 1) * 100
    : null;
}

// Full trading chart for one symbol in a modal dialog.
function ChartModal({
  ticker,
  date,
  sector,
  onClose,
}: {
  ticker: string;
  date: string;
  sector?: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="chart-modal"
      aria-label={`${ticker} chart`}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) dialog.current.close();
      }}
    >
      <div className="chart-modal-body">
        <div className="chart-modal-head">
          <h2>{ticker}</h2>
          <button
            type="button"
            className="chip"
            onClick={() => dialog.current?.close()}
          >
            Close
          </button>
        </div>
        <Suspense fallback={<p className="chart-status">Loading chart…</p>}>
          <DayChart
            ticker={ticker}
            date={date}
            sector={sector}
            className="big"
          />
        </Suspense>
      </div>
    </dialog>
  );
}

export function WatchBoard({
  board,
  symbols,
}: {
  board: Board;
  symbols: string[]; // watchlist order
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [compare, setCompare] = useState<"SPY" | "sector">("SPY");
  const bySymbol = new Map(board.series.map((s) => [s.ticker, s]));
  const spy = bySymbol.get("SPY")?.points;
  const against = (ticker: string) => {
    const sector = board.benchmarks[ticker];
    return compare === "sector" && sector ? sector : "SPY";
  };
  return (
    <section className="watch-board" aria-label="Watchlist">
      {Object.keys(board.benchmarks).length > 0 && (
        <div
          className="chips chart-modes"
          role="group"
          aria-label="Compare with"
        >
          <button
            type="button"
            className="chip"
            aria-pressed={compare === "SPY"}
            onClick={() => setCompare("SPY")}
          >
            vs SPY
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={compare === "sector"}
            onClick={() => setCompare("sector")}
          >
            vs sector
          </button>
        </div>
      )}
      <ul className="watch-grid">
        {symbols.map((ticker) => {
          const s = bySymbol.get(ticker);
          const pct = s ? change(s) : null;
          const last = s?.points.at(-1)?.[1];
          return (
            <li key={ticker}>
              <button
                type="button"
                className="watch-card"
                onClick={() => setOpen(ticker)}
                aria-label={`${ticker} chart`}
              >
                <span className="watch-name">
                  <strong>{ticker}</strong>
                  <span className="watch-price">
                    {last !== undefined ? `$${last.toFixed(2)}` : "—"}
                  </span>
                </span>
                <span
                  className={
                    pct === null
                      ? "watch-change"
                      : pct >= 0
                        ? "watch-change up"
                        : "watch-change down"
                  }
                >
                  {pct === null
                    ? ""
                    : `${pct >= 0 ? "▲" : "▼"} ${signed(pct)}%`}
                </span>
                <Sparkline
                  ticker={s?.points ?? []}
                  benchmark={
                    ticker === against(ticker)
                      ? undefined
                      : against(ticker) === "SPY"
                        ? spy
                        : bySymbol.get(against(ticker))?.points
                  }
                />
                <span className="watch-against">vs {against(ticker)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {open && (
        <ChartModal
          ticker={open}
          date={board.date}
          sector={board.benchmarks[open]}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}
