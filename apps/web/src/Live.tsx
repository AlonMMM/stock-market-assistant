import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Board } from "../../../packages/market-data/src/board.js";
import type { AlertLink } from "../../../packages/contracts/src/alert-link.js";
import type { LiveStatus } from "../../../packages/market-data/src/live.js";
import { AlertFeed } from "./AlertFeed.js";
import { readJson } from "./api.js";
import { pillFor } from "./live-model.js";
import { MarketStrip } from "./MarketStrip.js";
import { StatusPill } from "./StatusPill.js";
import { israelClock, israelDateTime, israelLabel } from "./time.js";
import { WatchBoard } from "./WatchBoard.js";

const liveRefreshMs = 30000;
// Board data is 15-minute-delayed SIP in 5-minute bars.
const boardRefreshMs = 5 * 60000;

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

export function Live({
  modes,
  link = null,
}: {
  modes: ReactNode;
  link?: AlertLink | null;
}) {
  const [warnings, setWarnings] = useState<string[]>([]);
  const [tab, setTab] = useState<"alerts" | "watchlist">("alerts");
  const warn = (message: string) =>
    setWarnings((w) => (w.at(-1) === message ? w : [...w, message]));
  const live = usePolling<LiveStatus>("/api/live", liveRefreshMs, warn);
  const board = usePolling<Board>("/api/board", boardRefreshMs, warn);
  // The collector returns no alerts while unreachable; keep the last ones.
  const kept = useRef<LiveStatus["alerts"]>([]);
  const status = live.value;
  if (status && status.state !== "unavailable") kept.current = status.alerts;
  const alerts = status ? kept.current : [];
  const now = Date.now();
  const pill = pillFor(status, now, live.at);
  const newestAlert = alerts.reduce<string | null>(
    (m, a) => (m === null || a.end > m ? a.end : m),
    null,
  );
  const linked =
    link && alerts.some((a) => a.ticker === link.ticker && a.end === link.end);
  const linkNotice =
    !link || !status || linked
      ? null
      : link.synthetic
        ? "This link came from a SYNTHETIC test alert, which is not stored. Links from real alerts open the alert here."
        : `The linked alert (${link.ticker}, ${israelDateTime(Date.parse(link.end))} ${israelLabel}) is not among the ${alerts.length} most recent live alerts.`;

  return (
    <div className="live-page">
      <header>
        <div className="brand-status">
          <span className="brand">
            SMA<span className="brand-dot">.</span>
          </span>
          <StatusPill
            pill={pill}
            status={status}
            checkedAt={live.at}
            refreshSeconds={liveRefreshMs / 1000}
            warnings={warnings}
            onClearWarnings={() => setWarnings([])}
          />
        </div>
        {modes}
      </header>
      {pill.kind === "offline" && (
        <p className="offline-banner" role="alert">
          <strong>
            Live alerts are paused — the collector is unreachable.
          </strong>{" "}
          {newestAlert
            ? `Showing the last alerts received, up to ${israelClock(Date.parse(newestAlert))}. `
            : ""}
          {live.at && `Checked ${israelClock(live.at)} ${israelLabel}.`}
          {status?.failure && ` (${status.failure})`}
        </p>
      )}

      <MarketStrip board={board.value} now={now} />

      <div
        role="tablist"
        aria-label="Live sections"
        className="tabs"
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          const next = tab === "alerts" ? "watchlist" : "alerts";
          setTab(next);
          document.getElementById(`tab-${next}`)?.focus();
        }}
      >
        {(
          [
            ["alerts", "Alerts", status ? alerts.length : null],
            ["watchlist", "Watchlist", board.value?.watchlist.length ?? null],
          ] as const
        ).map(([key, label, count]) => (
          <button
            type="button"
            role="tab"
            key={key}
            id={`tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`panel-${key}`}
            tabIndex={tab === key ? 0 : -1}
            onClick={() => setTab(key)}
          >
            {label}
            {count !== null && <span className="tab-count">{count}</span>}
          </button>
        ))}
      </div>

      {tab === "alerts" ? (
        <section
          role="tabpanel"
          id="panel-alerts"
          aria-labelledby="tab-alerts"
          className="tab-panel"
        >
          {linkNotice && <p className="notice">{linkNotice}</p>}
          {status && alerts.length === 0 && (
            <p className="notice">
              No live alerts yet. US pre-market opens 11:00 {israelLabel}, the
              regular session 16:30.
            </p>
          )}
          {alerts.length > 0 && (
            <AlertFeed
              alerts={alerts}
              benchmarks={board.value?.benchmarks}
              focus={linked ? link.ticker + link.end : undefined}
            />
          )}
        </section>
      ) : (
        <section
          role="tabpanel"
          id="panel-watchlist"
          aria-labelledby="tab-watchlist"
          className="tab-panel"
        >
          {board.value ? (
            <WatchBoard board={board.value} symbols={board.value.watchlist} />
          ) : (
            <p className="chart-status">Loading watchlist…</p>
          )}
        </section>
      )}
    </div>
  );
}
