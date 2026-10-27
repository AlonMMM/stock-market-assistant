import { lazy, Suspense, useMemo, type ReactNode } from "react";
import type {
  PortfolioHistory,
  PortfolioPosition,
} from "../../../packages/trading/src/portfolio.js";
import { usePolling } from "./Live.js";
import { liveTrade } from "./trade-story-model.js";
import type { TradeSource } from "./TradeStory.js";

// An open position's trade window, under its row in Live trades (user
// 2026-10-27: "The page in the image should be open instead of the regular
// graph when I click on ongoing trade"): the same summary, chart, reasons
// and fills as a closed trade's, valued at the last price and kept fresh.

const TradeStoryBody = lazy(() =>
  import("./TradeStory.js").then((m) => ({ default: m.TradeStoryBody })),
);
const ignore = () => {};
// The account's fills: new buys and sales show within this.
const fillsMs = 30000;

export function LiveTrade({
  p,
  history,
  source,
  fallback,
}: {
  p: PortfolioPosition;
  // The account's history address (its open trades come with it).
  history: string;
  source: TradeSource;
  // Shown when the trade's fills are older than the activity read.
  fallback: ReactNode;
}) {
  const { value, error } = usePolling<PortfolioHistory>(
    history,
    fillsMs,
    ignore,
  );
  const lot = value?.open?.find((l) => l.symbol === p.symbol);
  const t = useMemo(
    () => (lot ? liveTrade(lot, p, Date.now()) : null),
    // Rebuilt when a fill or the price changes, not on every render.
    [lot, p.price, p.qty],
  );
  if (!value)
    return (
      <p className="chart-status">
        {error ? `The trade is unavailable: ${error}` : "Loading the trade…"}
      </p>
    );
  if (!t)
    return (
      <>
        <p className="muted">
          This trade&apos;s fills are older than the account&apos;s recent
          activity, so its window cannot be drawn; the stock&apos;s day chart
          instead.
        </p>
        {fallback}
      </>
    );
  return (
    <div className="live-trade">
      <Suspense fallback={<p className="chart-status">Loading the trade…</p>}>
        <TradeStoryBody t={t} source={source} live={{ held: p.qty }} />
      </Suspense>
    </div>
  );
}
