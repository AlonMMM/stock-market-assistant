import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  earningsBadge,
  type EarningsBadge as Badge,
  type EarningsCalendar,
} from "../../../packages/market-data/src/earnings.js";

// A small earnings badge next to a ticker, everywhere in the app (user
// 2026-10-29): "Earnings today", "After earnings" (the first trading day
// after the report), "Earnings <day>" (within the next 5 trading days). A tap
// shows the date and time at the bottom of the screen for a few seconds. The calendar is read once and again every hour,
// shared by every badge on the page.

const refreshMs = 3600_000;
let calendar: EarningsCalendar | null = null;
let readAt = 0;
let reading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function read() {
  if (reading || Date.now() - readAt < refreshMs) return;
  reading = fetch("/api/earnings", { signal: AbortSignal.timeout(30000) })
    .then((r) => (r.ok ? (r.json() as Promise<EarningsCalendar>) : null))
    .then((next) => {
      if (next?.reports) {
        calendar = next;
        for (const l of listeners) l();
      }
    })
    .catch(() => {}) // no badges until the next read
    .finally(() => {
      readAt = Date.now();
      reading = null;
    });
}

/** The badge `symbol` shows now, from the shared calendar. */
export function useEarnings(symbol: string): Badge | null {
  const [, redraw] = useState(0);
  useEffect(() => {
    const listener = () => redraw((n) => n + 1);
    listeners.add(listener);
    read();
    const timer = setInterval(read, refreshMs);
    return () => {
      listeners.delete(listener);
      clearInterval(timer);
    };
  }, []);
  return calendar
    ? earningsBadge(calendar.reports[symbol.toUpperCase()], Date.now())
    : null;
}

const weekday = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  timeZone: "UTC",
});
const longDate = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const at = (date: string) => Date.parse(`${date}T12:00:00Z`);

/** The badge's words: short, and the sentence a tap shows. */
export function badgeText(b: Badge, compact = false) {
  const when = b.time ? `, ${b.time}` : "";
  const day = longDate.format(at(b.date));
  if (b.kind === "today")
    return {
      label: compact ? "ER today" : "Earnings today",
      detail: `Earnings today${when || " (time not given)"}.`,
    };
  if (b.kind === "after")
    return {
      label: compact ? "After ER" : "After earnings",
      detail: `Reported ${day}${when}: today is the first trading day after.`,
    };
  return {
    label: `${compact ? "ER" : "Earnings"} ${weekday.format(at(b.date))}`,
    detail: `Earnings ${day}${when || " (time not given)"}.`,
  };
}

/**
 * The badge for `symbol`, or nothing. `compact` for tight rows (the
 * Watchlist): "ER today", "After ER", "ER Thu".
 */
export function EarningsBadge({
  symbol,
  compact = false,
}: {
  symbol: string;
  compact?: boolean;
}) {
  const badge = useEarnings(symbol);
  const [open, setOpen] = useState(false);
  // The detail closes by itself after a few seconds.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => setOpen(false), 5000);
    return () => clearTimeout(timer);
  }, [open]);
  if (!badge) return null;
  const { label, detail } = badgeText(badge, compact);
  // Inside a row that opens the stock, the tap is for the badge.
  const toggle = (e: { stopPropagation(): void; preventDefault(): void }) => {
    e.stopPropagation();
    e.preventDefault();
    setOpen(!open);
  };
  return (
    <span className="eb-wrap">
      {/* A span, not a button: the badge often sits inside a row that is
          itself a button (a Watchlist row opens the stock). */}
      <span
        role="button"
        tabIndex={0}
        className={`eb eb-${badge.kind}`}
        title={detail}
        aria-label={`${symbol}: ${detail}`}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") toggle(e);
        }}
      >
        {label}
      </span>
      {/* On the page itself, not in the row: rows and sticky columns would
          cover it. */}
      {open &&
        createPortal(
          <span className="eb-detail" role="status">
            {detail}
          </span>,
          document.body,
        )}
    </span>
  );
}
