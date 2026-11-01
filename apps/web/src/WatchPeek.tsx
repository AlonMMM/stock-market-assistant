import { useEffect, useState } from "react";
import { StockTags } from "./StockTags";
import type { Candles } from "../../../packages/market-data/src/candles.js";
import type { TickerInfo } from "../../../packages/market-data/src/ticker.js";
import { usePolling } from "./Live.js";
import { ibPrice, type WatchRow } from "./live-model.js";
import { israelClock } from "./time.js";

// A stock's quick look under its watchlist row (user 2026-10-31: "on one
// click on a stock I want to open a tiny graph like in the image and only on
// another click open the page"), as IBKR's: the bid and ask, the last two
// hours, today's and the 52 weeks' high and low.

const refreshMs = 60_000;
const windowMinutes = 120;
const ignore = () => {};

/** The last two hours of 1-minute closes, the regular session's when it has any. */
function lastTwoHours(value: Candles | null): [number, number][] {
  const all = value?.candles ?? [];
  const regular = all.filter((c) => c.session === "regular");
  const shown = regular.length > 1 ? regular : all;
  return shown.slice(-windowMinutes).map((c) => [c.start, c.close]);
}

/** Four price marks from the high down to the low. */
function priceMarks(low: number, high: number): number[] {
  const step = (high - low) / 3;
  return [0, 1, 2, 3].map((i) => high - i * step);
}

function PeekChart({ points }: { points: [number, number][] }) {
  if (points.length < 2)
    return (
      <p className="wl-peek-empty muted">No trades in the last 2 hours.</p>
    );
  const closes = points.map(([, c]) => c);
  const low = Math.min(...closes);
  const high = Math.max(...closes);
  const span = high - low || 1;
  const first = points[0]![0];
  const last = points.at(-1)![0];
  const width = last - first || 1;
  const xy = points.map(
    ([t, c]) =>
      `${(((t - first) / width) * 100).toFixed(2)},${(((high - c) / span) * 100).toFixed(2)}`,
  );
  const up = closes.at(-1)! >= closes[0]!;
  const middle = points[Math.floor(points.length / 2)]![0];
  return (
    <div className="wl-peek-chart">
      <span className="wl-peek-tag">2h</span>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className={up ? "up" : "down"}
        role="img"
        aria-label={`Last 2 hours, from ${ibPrice(closes[0]!)} to ${ibPrice(closes.at(-1)!)}`}
      >
        <polygon points={`0,100 ${xy.join(" ")} 100,100`} />
        <polyline points={xy.join(" ")} />
      </svg>
      <span className="wl-peek-prices num" aria-hidden="true">
        {priceMarks(low, high).map((p, i) => (
          <span key={i}>{ibPrice(p)}</span>
        ))}
      </span>
      <span className="wl-peek-times num" aria-hidden="true">
        {[first, middle, last].map((t) => (
          <span key={t}>{israelClock(t * 1000)}</span>
        ))}
      </span>
    </div>
  );
}

function Range({
  label,
  high,
  low,
}: {
  label: string;
  high: number | null | undefined;
  low: number | null | undefined;
}) {
  return (
    <div className="wl-peek-range">
      <span>{label}</span>
      <b className="num">{high == null ? "—" : ibPrice(high)}</b>
      <b className="num">{low == null ? "—" : ibPrice(low)}</b>
    </div>
  );
}

export function WatchPeek({
  row,
  date,
  onOpen,
}: {
  row: WatchRow;
  date: string;
  onOpen: () => void;
}) {
  const { value: candles } = usePolling<Candles>(
    `/api/candles?ticker=${encodeURIComponent(row.ticker)}&date=${date}`,
    refreshMs,
    ignore,
  );
  // Bid / ask and the 52 weeks: read once when the row opens.
  const [info, setInfo] = useState<TickerInfo | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch(`/api/ticker?ticker=${encodeURIComponent(row.ticker)}`, {
      signal: abort.signal,
    })
      .then((r) => (r.ok ? (r.json() as Promise<TickerInfo>) : null))
      .then(setInfo)
      .catch(() => {});
    return () => abort.abort();
  }, [row.ticker]);
  const bid = info?.quote?.bid ?? null;
  const ask = info?.quote?.ask ?? null;
  return (
    <div className="wl-peek">
      <StockTags symbol={row.ticker} block />
      <div className="wl-peek-book num">
        <span className="wl-peek-bid">
          <span>Bid</span>
          {bid === null ? "—" : ibPrice(bid)}
        </span>
        <span className="wl-peek-ask">
          {ask === null ? "—" : ibPrice(ask)}
          <span>Ask</span>
        </span>
      </div>
      <PeekChart points={lastTwoHours(candles)} />
      <div className="wl-peek-ranges">
        <Range label="Today" high={row.dayHigh} low={row.dayLow} />
        <Range
          label="52 wk"
          high={info?.stats?.yearHigh}
          low={info?.stats?.yearLow}
        />
      </div>
      <button type="button" className="wl-peek-open" onClick={onOpen}>
        Open {row.ticker} ›
      </button>
    </div>
  );
}
