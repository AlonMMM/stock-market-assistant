import type { Candles } from "../../../packages/market-data/src/candles.js";
import { usePolling } from "./Live.js";
import { DaySpark } from "./Sparkline.js";

// SPY and QQQ on top of the watchlist (user 2026-10-19): the price, the
// day's change and today's line, each opening its own page.

const marketTickers = ["SPY", "QQQ"] as const;
const refreshMs = 60_000;
// The last two hours of 1-minute closes (user 2026-10-19: "more sharp, take
// less time if you need"): a small move fills the card.
const windowMinutes = 120;
const ignore = () => {};

function MarketCard({
  ticker,
  date,
  onOpen,
}: {
  ticker: string;
  date: string;
  onOpen: (ticker: string) => void;
}) {
  const { value } = usePolling<Candles>(
    `/api/candles?ticker=${ticker}&date=${date}`,
    refreshMs,
    ignore,
  );
  const regular = (value?.candles ?? []).filter((c) => c.session === "regular");
  const shown = regular.length > 1 ? regular : (value?.candles ?? []);
  const points = shown
    .slice(-windowMinutes)
    .map((c) => [c.start, c.close] as [number, number]);
  const last = value?.last?.price ?? shown.at(-1)?.close ?? null;
  const prev = value?.previousClose ?? null;
  const change = last !== null && prev ? ((last - prev) / prev) * 100 : null;
  return (
    <button
      type="button"
      className="mkt-card"
      aria-label={`Open ${ticker}`}
      onClick={() => onOpen(ticker)}
    >
      <b>
        {ticker} <small>last 2 h</small>
      </b>
      <span className="num">
        {last === null ? "—" : last.toFixed(2)}{" "}
        {change !== null && (
          <span className={change >= 0 ? "up" : "down"}>
            {change >= 0 ? "+" : "−"}
            {Math.abs(change).toFixed(2)}%
          </span>
        )}
      </span>
      <span className="mkt-spark">
        {points.length > 1 ? (
          <DaySpark
            points={points}
            previousClose={prev}
            width={600}
            height={84}
            tight
          />
        ) : (
          <small>{value ? "No trades yet today" : "Loading…"}</small>
        )}
      </span>
    </button>
  );
}

export function MarketCards({
  date,
  onOpen,
}: {
  date: string;
  onOpen: (ticker: string) => void;
}) {
  return (
    <div className="mkt-strip" role="group" aria-label="Market">
      {marketTickers.map((t) => (
        <MarketCard key={t} ticker={t} date={date} onOpen={onOpen} />
      ))}
    </div>
  );
}
