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
  onClose,
}: {
  ticker: string;
  date: string;
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
          <DayChart ticker={ticker} date={date} className="big" />
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
  const bySymbol = new Map(board.series.map((s) => [s.ticker, s]));
  const spy = bySymbol.get("SPY")?.points;
  return (
    <section className="watch-board" aria-label="Watchlist">
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
                  benchmark={ticker === "SPY" ? undefined : spy}
                />
              </button>
            </li>
          );
        })}
      </ul>
      {open && (
        <ChartModal
          ticker={open}
          date={board.date}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}
