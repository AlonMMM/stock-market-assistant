import { lazy, Suspense, useState } from "react";
import type { Board } from "../../../packages/market-data/src/board.js";
import { boardChange, duration, marketPhase, whenLabel } from "./live-model.js";
import { Sparkline } from "./Sparkline.js";
import { israelClock, israelLabel } from "./time.js";

const DayChart = lazy(() =>
  import("./DayChart.js").then((m) => ({ default: m.DayChart })),
);

const names: Record<string, string> = { QQQ: "Nasdaq-100", SPY: "S&P 500" };

export const signedPct = (n: number) =>
  `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;

function SessionTile({ now }: { now: number }) {
  const market = marketPhase(now);
  const day = market.day ?? market.next;
  const [title, detail] =
    market.phase === "regular"
      ? ["Regular session", `closes ${israelClock(market.day!.close)}`]
      : market.phase === "pre"
        ? ["Pre-market", `opens ${israelClock(market.day!.open)}`]
        : market.phase === "post"
          ? ["After-hours", `ends ${israelClock(market.day!.postEnd)}`]
          : market.phase === "closed"
            ? [
                "Market closed",
                market.next
                  ? `pre-market ${whenLabel(market.next.preStart, now)}`
                  : "",
              ]
            : ["Session unknown", "outside the exchange calendar"];
  const until =
    market.phase === "regular"
      ? market.day!.close
      : market.phase === "pre"
        ? market.day!.open
        : market.phase === "post"
          ? market.day!.postEnd
          : null;
  const parts = day
    ? [day.open - day.preStart, day.close - day.open, day.postEnd - day.close]
    : [];
  const mark =
    market.day && day
      ? ((now - day.preStart) / (day.postEnd - day.preStart)) * 100
      : null;
  return (
    <div className="market-tile session-tile">
      <span className="session-head">
        <strong>{title}</strong>
        <span>
          {detail}
          {until !== null && ` · ${duration(until - now)}`}
        </span>
      </span>
      {day && (
        <>
          <div className="timeline" aria-hidden="true">
            {parts.map((ms, i) => (
              <span
                key={i}
                className={i === 1 ? "regular" : ""}
                style={{ flex: ms }}
              />
            ))}
            {mark !== null && (
              <i className="timeline-now" style={{ left: `${mark}%` }} />
            )}
          </div>
          <span className="timeline-labels">
            <span>Pre {israelClock(day.preStart)}</span>
            <span>Open {israelClock(day.open)}</span>
            <span>Close {israelClock(day.close)}</span>
            <span>{israelClock(day.postEnd)}</span>
          </span>
          <span className="sr-only">
            {`Pre-market ${israelClock(day.preStart)}, regular session ${israelClock(day.open)} to ${israelClock(day.close)}, after-hours to ${israelClock(day.postEnd)}, ${israelLabel}.`}
          </span>
        </>
      )}
      <small className="tile-note">Times in {israelLabel}</small>
    </div>
  );
}

/** QQQ and SPY tiles plus the session timeline; a tile opens the market chart. */
export function MarketStrip({
  board,
  now,
}: {
  board: Board | null;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const bySymbol = new Map(board?.series.map((s) => [s.ticker, s]));
  return (
    <>
      <section className="market-strip" aria-label="Market">
        {["QQQ", "SPY"].map((ticker) => {
          const s = bySymbol.get(ticker);
          const change = boardChange(s);
          return (
            <button
              type="button"
              key={ticker}
              className="market-tile"
              aria-expanded={open}
              aria-controls="market-chart"
              onClick={() => setOpen(!open)}
            >
              <span className="tile-name">
                <strong>{ticker}</strong>
                <span>{names[ticker]}</span>
              </span>
              <span
                className={
                  change === null
                    ? "tile-change"
                    : `tile-change ${change >= 0 ? "up" : "down"}`
                }
              >
                {change === null
                  ? board
                    ? "—"
                    : "Loading…"
                  : `${change >= 0 ? "▲" : "▼"} ${signedPct(change)}`}
              </span>
              <span className="tile-spark">
                {s && <Sparkline ticker={s.points} />}
              </span>
              <span className="sr-only">
                {open ? "Hide" : "Show"} the market day chart
              </span>
            </button>
          );
        })}
        <SessionTile now={now} />
      </section>
      {open && (
        <section
          className="market-chart"
          id="market-chart"
          aria-label="Market chart"
        >
          <p className="chart-status">
            Nasdaq-100 (QQQ) vs S&amp;P 500 (SPY)
            {board && ` · session ${board.date}`} · SIP, 15-min delayed
          </p>
          {board ? (
            <Suspense fallback={<p className="chart-status">Loading chart…</p>}>
              <DayChart ticker="QQQ" date={board.date} />
            </Suspense>
          ) : (
            <p className="chart-status">Loading market…</p>
          )}
        </section>
      )}
    </>
  );
}
