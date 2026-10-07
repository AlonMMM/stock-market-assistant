import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Board } from "../../../packages/market-data/src/board.js";
import type { AlertLink } from "../../../packages/contracts/src/alert-link.js";
import type { LiveStatus } from "../../../packages/market-data/src/live.js";
import { readJson } from "./api.js";
import { pillFor } from "./live-model.js";
import { LiveAlerts } from "./LiveAlerts.js";
import { MarketStrip } from "./MarketStrip.js";
import { StatusPill } from "./StatusPill.js";
import { israelClock, israelDateTime, israelLabel } from "./time.js";
import { WatchTable } from "./WatchTable.js";
import { EngineTickers } from "./EngineTickers.js";

const liveRefreshMs = 30000;
// Board data is SIP in 5-minute bars, delayed by the API's `delayMinutes`.
const boardRefreshMs = 5 * 60000;

// Polls `path` while the page is visible.
export function usePolling<T>(
  path: string,
  every: number,
  onError: (m: string) => void,
) {
  const [value, setValue] = useState<T | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
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
        setError(null);
        setAt(Date.now());
      } catch (e) {
        if (!active) return;
        const message = e instanceof Error ? e.message : `${path} failed`;
        setError(message);
        onError(message);
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
  return { value, at, error };
}

// Alerts newer than the viewer's previous visit are marked "New". Stored
// per device; the visit time updates on load and whenever the page is hidden.
const visitKey = "sma.live.lastVisit.v1";
function useLastVisit(): number | null {
  const [since] = useState(() => {
    try {
      const v = Number(localStorage.getItem(visitKey));
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    const save = () => {
      try {
        localStorage.setItem(visitKey, String(Date.now()));
      } catch {
        // Without storage nothing is marked new on the next visit.
      }
    };
    const hidden = () => document.visibilityState === "hidden" && save();
    save();
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
  return since;
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
  const [symbol, setSymbol] = useState<string | null>(null);
  const since = useLastVisit();
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
  const emptyText = !status
    ? "Loading live alerts…"
    : pill.kind === "warming"
      ? "The collector is warming up (loading recent history). Live alerts appear once it is done."
      : pill.kind === "off"
        ? "Alpaca streaming is switched off, so no live alerts will arrive."
        : pill.kind === "offline"
          ? "No alerts to show: the collector is unreachable."
          : `No live alerts yet. US pre-market opens 11:00 ${israelLabel}, the regular session 16:30.`;
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
            chartDelay={
              board.value ? { minutes: board.value.delayMinutes } : undefined
            }
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

      <MarketStrip board={board.value} failed={!!board.error} now={now} />

      <EngineTickers />

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
          {alerts.length > 0 ? (
            <LiveAlerts
              alerts={alerts}
              benchmarks={board.value?.benchmarks}
              focus={linked ? link.ticker + link.end : undefined}
              symbol={symbol}
              onSymbol={setSymbol}
              since={since}
              strengthNow={status?.strengthNow}
            />
          ) : (
            <p className="notice">{emptyText}</p>
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
            <WatchTable
              board={board.value}
              alerts={alerts}
              onShowAlerts={(ticker) => {
                setSymbol(ticker);
                setTab("alerts");
              }}
            />
          ) : (
            <p className={board.error ? "notice error" : "chart-status"}>
              {board.error
                ? `Watchlist unavailable: ${board.error}`
                : "Loading watchlist…"}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
