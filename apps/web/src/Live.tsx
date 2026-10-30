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

export const liveRefreshMs = 30000;
// Board data is SIP in 5-minute bars, delayed by the API's `delayMinutes`.
export const boardRefreshMs = 5 * 60000;

// Polls `path` while the page is visible.
// The last answer per address, kept while the page is open: a section opened
// again shows it at once and refreshes when it is due (user 2026-10-17: no
// reload on every tab switch).
const polled = new Map<string, { value: unknown; at: number }>();

// The watchlist's answers are also kept in this browser (user 2026-10-19:
// "cache! seeing the loader each time is frustrating"): a visit, a reload or
// another list shows the last answer at once and reads a new one behind it.
const storedPrefix = "sma.poll.v1:";
const storedMax = 1_500_000; // characters per answer
const storedKeep = 12; // answers kept; the oldest goes first
const persisted = (path: string) =>
  path.startsWith("/api/board") || path.startsWith("/api/candles");
function readStored(path: string) {
  try {
    const raw = localStorage.getItem(storedPrefix + path);
    return raw ? (JSON.parse(raw) as { value: unknown; at: number }) : null;
  } catch {
    return null;
  }
}
function writeStored(path: string, entry: { value: unknown; at: number }) {
  try {
    const raw = JSON.stringify(entry);
    if (raw.length > storedMax) return;
    localStorage.setItem(storedPrefix + path, raw);
    const keys = Object.keys(localStorage).filter((k) =>
      k.startsWith(storedPrefix),
    );
    if (keys.length > storedKeep)
      keys
        .map(
          (k) =>
            [k, readStored(k.slice(storedPrefix.length))?.at ?? 0] as const,
        )
        .sort((a, b) => a[1] - b[1])
        .slice(0, keys.length - storedKeep)
        .forEach(([k]) => localStorage.removeItem(k));
  } catch {
    // Full or blocked storage: kept for this visit only.
  }
}
/** The last answer for `path`: this visit's, else this browser's. */
function kept(path: string) {
  const memory = polled.get(path);
  if (memory || !persisted(path)) return memory;
  const stored = readStored(path);
  if (stored) polled.set(path, stored);
  return stored ?? undefined;
}
function keep(path: string, value: unknown, at: number) {
  polled.set(path, { value, at });
  if (persisted(path)) writeStored(path, { value, at });
}

/**
 * Reads `path` ahead (another watchlist) when it has no answer younger than
 * `every`, so switching to it shows its rows at once.
 */
export async function prefetch(path: string, every: number) {
  const known = kept(path);
  if (known && Date.now() - known.at < every) return;
  try {
    const value = await readJson<unknown>(
      await fetch(path, { signal: AbortSignal.timeout(30000) }),
    );
    keep(path, value, Date.now());
  } catch {
    // It is read when it is opened.
  }
}

/** Reads `path` every `every` ms while the page is visible; a null path reads nothing. */
export function usePolling<T>(
  path: string | null,
  every: number,
  onError: (m: string) => void,
) {
  const [value, setValue] = useState<T | null>(() =>
    path === null ? null : ((kept(path)?.value as T | undefined) ?? null),
  );
  const [at, setAt] = useState<number | null>(() =>
    path === null ? null : (kept(path)?.at ?? null),
  );
  const [error, setError] = useState<string | null>(null);
  // Set by `reload`: load this address now, past its kept answer.
  const [reloaded, setReloaded] = useState<{ path: string } | null>(null);
  useEffect(() => {
    if (path === null) return;
    let active = true;
    const force = reloaded?.path === path;
    const last = force ? undefined : kept(path);
    // A new address (another list, "vs sector") shows its own last answer;
    // a reload keeps what is shown until the new answer comes.
    if (!force) {
      setValue((last?.value as T | undefined) ?? null);
      setAt(last?.at ?? null);
    }
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await readJson<T>(
          await fetch(path, { signal: AbortSignal.timeout(30000) }),
        );
        const now = Date.now();
        keep(path, next, now);
        if (!active) return;
        setValue(next);
        setError(null);
        setAt(now);
      } catch (e) {
        if (!active) return;
        const message = e instanceof Error ? e.message : `${path} failed`;
        setError(message);
        onError(message);
      }
    };
    // Fresh enough: the first load waits until the answer is due.
    const due = last ? Math.max(0, last.at + every - Date.now()) : 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(() => {
      void load();
      timer = setInterval(load, every);
    }, due);
    document.addEventListener("visibilitychange", load);
    return () => {
      active = false;
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
    // onError only records warnings; it need not restart polling.
  }, [path, every, reloaded]);
  return {
    value,
    at,
    error,
    reload: () => {
      if (path !== null) setReloaded({ path });
    },
  };
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
  initialSymbol = null,
}: {
  modes: ReactNode;
  link?: AlertLink | null;
  // A symbol picked in the watchlist: its alerts are shown.
  initialSymbol?: string | null;
}) {
  const [warnings, setWarnings] = useState<string[]>([]);
  const [symbol, setSymbol] = useState<string | null>(initialSymbol);
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

      <h2 className="wl-title">
        Alerts
        {status && <span className="count num">{alerts.length}</span>}
      </h2>
      <section aria-label="Live alerts">
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
    </div>
  );
}
