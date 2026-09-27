import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import type { Board } from "../../../packages/market-data/src/board.js";
import type { LiveStatus } from "../../../packages/market-data/src/live.js";
import { AlertFeed } from "./AlertFeed.js";
import { readJson } from "./api.js";
import { Notices } from "./Notices.js";
import { israelClock, israelDateTime, israelLabel } from "./time.js";
import { WatchBoard } from "./WatchBoard.js";

const DayChart = lazy(() =>
  import("./DayChart.js").then((m) => ({ default: m.DayChart })),
);

const liveRefreshMs = 30000;
// Board data is 15-minute-delayed SIP in 5-minute bars.
const boardRefreshMs = 5 * 60000;

const stateText: Record<string, string> = {
  subscribed: "Connected · waiting for bars",
  "warming-up": "Warming up history…",
  starting: "Starting…",
  "awaiting-watchlist": "Waiting for the first IBKR watchlist sync",
  "awaiting-alpaca-activation": "Alpaca streaming is switched off",
  disconnected: "Disconnected",
  unavailable: "Collector unreachable",
};

// Polls `path` while the page is visible.
function usePolling<T>(
  path: string,
  every: number,
  onError: (m: string) => void,
) {
  const [value, setValue] = useState<T | null>(null);
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await readJson<T>(
          await fetch(path, { signal: AbortSignal.timeout(30000) }),
        );
        if (!active) return;
        setValue(next);
        setAt(Date.now());
      } catch (e) {
        if (active) onError(e instanceof Error ? e.message : `${path} failed`);
      }
    };
    void load();
    const timer = setInterval(load, every);
    document.addEventListener("visibilitychange", load);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
    // onError only records warnings; it need not restart polling.
  }, [path, every]);
  return { value, at };
}

export function Live({ modes }: { modes: ReactNode }) {
  const [warnings, setWarnings] = useState<string[]>([]);
  const warn = (message: string) =>
    setWarnings((w) => (w.at(-1) === message ? w : [...w, message]));
  const live = usePolling<LiveStatus>("/api/live", liveRefreshMs, warn);
  const board = usePolling<Board>("/api/board", boardRefreshMs, warn);
  const status = live.value;
  useEffect(() => {
    if (status?.failure) warn(status.failure);
  }, [status?.failure]);

  // A bar older than 3 minutes while connected usually means the market is
  // closed (or the feed stalled); the bar time is shown so either is visible.
  const receiving =
    status?.state === "subscribed" &&
    status.lastBarAt !== null &&
    Date.now() - Date.parse(status.lastBarAt) < 3 * 60000;
  const statusText = !status
    ? "Connecting…"
    : receiving
      ? "Live · receiving 1-minute bars"
      : (stateText[status.state] ?? status.state);
  const day = board.value?.date;

  return (
    <>
      <header>
        <span className="brand">
          SMA<span className="brand-dot">.</span>
        </span>
        {modes}
      </header>
      <Notices items={warnings} />
      <section className="live-status" aria-live="polite">
        <p className="live-state">
          <span
            className={
              receiving
                ? "live-dot on"
                : status?.state === "subscribed"
                  ? "live-dot idle"
                  : "live-dot off"
            }
            aria-hidden="true"
          />
          <strong>{statusText}</strong>
        </p>
        {status && status.state !== "unavailable" && (
          <p className="live-meta">
            {status.feed?.toUpperCase()} · {status.symbols} live symbols ·{" "}
            {status.lastBarAt
              ? `last bar ${israelDateTime(Date.parse(status.lastBarAt))}`
              : "no live bars yet"}
            {live.at && ` · checked ${israelClock(live.at)} ${israelLabel}`}
          </p>
        )}
      </section>

      <section className="market">
        <h2 className="section-title">
          Market{" "}
          <small>
            Nasdaq-100 (QQQ) vs S&P 500 (SPY)
            {day && ` · session ${day}`}
          </small>
        </h2>
        {day ? (
          <Suspense fallback={<p className="chart-status">Loading chart…</p>}>
            <DayChart ticker="QQQ" date={day} />
          </Suspense>
        ) : (
          <p className="chart-status">Loading market…</p>
        )}
      </section>

      <section>
        <h2 className="section-title">
          Live alerts{" "}
          {status && status.alerts.length > 0 && (
            <small>{status.alerts.length} recent</small>
          )}
        </h2>
        {status && status.alerts.length === 0 && (
          <p className="notice">
            No live alerts yet. US pre-market opens 11:00 {israelLabel}, the
            regular session 16:30.
          </p>
        )}
        {status && status.alerts.length > 0 && (
          <AlertFeed alerts={status.alerts} />
        )}
      </section>

      <section>
        <h2 className="section-title">
          Watchlist{" "}
          {board.value && (
            <small>
              {board.value.watchlist.length} symbols · vs SPY (dashed) · 15-min
              delayed
            </small>
          )}
        </h2>
        {board.value ? (
          <WatchBoard board={board.value} symbols={board.value.watchlist} />
        ) : (
          <p className="chart-status">Loading watchlist charts…</p>
        )}
      </section>
      <footer>
        Live alerts: Alpaca{" "}
        {status?.feed === "iex" ? "IEX (one exchange's volume)" : "stream"},
        refreshed every 30 s. Charts: Alpaca SIP, 15-minute delayed.
      </footer>
    </>
  );
}
