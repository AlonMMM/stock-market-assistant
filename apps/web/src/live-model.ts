// Pure view logic for the Live page: status pill, session timeline, alert
// filtering/grouping and watchlist rows. No DOM access, so Node tests import it.
import type { Evaluation } from "../../../packages/alerts/src/relative-volume.js";
import type {
  Board,
  BoardSeries,
} from "../../../packages/market-data/src/board.js";
import {
  coreClose,
  newYork,
  newYorkToUtc,
} from "../../../packages/market-data/src/calendar.js";
import type { LiveStatus } from "../../../packages/market-data/src/live.js";
import {
  israelClock,
  israelDate,
  israelDayLabel,
  israelWeekday,
} from "./time.js";

// ---------------------------------------------------------------- sessions

/** One US trading day's extended and regular session bounds (UTC ms). */
export interface SessionDay {
  date: string; // US (New York) session date
  preStart: number; // 04:00 New York
  open: number; // 09:30 New York
  close: number; // 16:00, or 13:00 on early-close days
  postEnd: number; // 20:00 New York
}

export function sessionDay(date: string): SessionDay | null {
  let close: number | null;
  try {
    close = coreClose(date);
  } catch {
    return null; // outside the published calendar
  }
  if (close === null) return null;
  return {
    date,
    preStart: newYorkToUtc(date, 240),
    open: newYorkToUtc(date, 570),
    close: newYorkToUtc(date, close),
    postEnd: newYorkToUtc(date, 1200),
  };
}

export type Phase = "pre" | "regular" | "post" | "closed" | "unknown";

export interface MarketPhase {
  phase: Phase;
  day: SessionDay | null; // the session containing now, if any
  next: SessionDay | null; // next session whose pre-market has not started
}

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Where `now` falls in the US equity sessions, per the exchange calendar. */
export function marketPhase(now: number): MarketPhase {
  const today = newYork(now).date;
  try {
    coreClose(today);
  } catch {
    return { phase: "unknown", day: null, next: null };
  }
  const day = sessionDay(today);
  let next: SessionDay | null = null;
  if (day && now < day.preStart) next = day;
  for (let i = 1; !next && i <= 14; i++) next = sessionDay(addDays(today, i));
  if (day && now >= day.preStart && now < day.postEnd)
    return {
      phase: now < day.open ? "pre" : now < day.close ? "regular" : "post",
      day,
      next,
    };
  return { phase: "closed", day: null, next };
}

/** "11:00" today, else "Mon 11:00", in Israel time. */
export function whenLabel(ms: number, now: number): string {
  return israelDate(ms) === israelDate(now)
    ? israelClock(ms)
    : `${israelWeekday(ms)} ${israelClock(ms)}`;
}

/** "5 h 15 m" / "42 m". */
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(minutes / 60);
  return h ? `${h} h ${minutes % 60} m` : `${minutes} m`;
}

// ------------------------------------------------------------- status pill

export type PillKind =
  | "connecting"
  | "live"
  | "closed"
  | "warming"
  | "off"
  | "delayed"
  | "reconnecting"
  | "offline"
  | "waiting";

export interface Pill {
  kind: PillKind;
  tone: "green" | "grey" | "amber" | "red";
  // Shape carries the state alongside colour.
  icon: "dot" | "ring" | "dashed" | "square" | "warn" | "error";
  label: string;
  detail: string; // shown after the label, starts with "· " when present
  heading: string; // popover title
}

/** Newest live bar older than this, inside a session, counts as delayed. */
export const delayedAfterMs = 3 * 60000;

export function pillFor(
  status: LiveStatus | null,
  now: number,
  checkedAt: number | null,
): Pill {
  if (!status)
    return {
      kind: "connecting",
      tone: "grey",
      icon: "dashed",
      label: "Connecting",
      detail: "",
      heading: "Checking the live collector…",
    };
  switch (status.state) {
    case "unavailable":
      return {
        kind: "offline",
        tone: "red",
        icon: "error",
        label: "Offline",
        detail: checkedAt ? `· checked ${israelClock(checkedAt)}` : "",
        heading: "Offline · the live collector is unreachable",
      };
    case "disconnected":
      return {
        kind: "reconnecting",
        tone: "amber",
        icon: "warn",
        label: "Reconnecting",
        detail: "",
        heading: "Reconnecting · the stream dropped",
      };
    case "awaiting-alpaca-activation":
      return {
        kind: "off",
        tone: "grey",
        icon: "square",
        label: "Streaming off",
        detail: "",
        heading: "Alpaca streaming is switched off",
      };
    case "warming-up":
    case "starting":
      return {
        kind: "warming",
        tone: "grey",
        icon: "dashed",
        label: "Warming up",
        detail: "· loading history",
        heading: "Warming up · loading recent bars",
      };
    case "subscribed":
      break;
    default:
      return {
        kind: "waiting",
        tone: "grey",
        icon: "ring",
        label:
          status.state === "awaiting-watchlist"
            ? "Waiting for watchlist"
            : status.state,
        detail: "",
        heading:
          status.state === "awaiting-watchlist"
            ? "Waiting for the first IBKR watchlist sync"
            : `Collector state: ${status.state}`,
      };
  }
  const last = status.lastBarAt ? Date.parse(status.lastBarAt) : null;
  if (last !== null && now - last < delayedAfterMs)
    return {
      kind: "live",
      tone: "green",
      icon: "dot",
      label: "Live",
      detail: `· ${status.receiving}/${status.symbols} · ${israelClock(last)}`,
      heading: "Live · receiving 1-minute bars",
    };
  const market = marketPhase(now);
  if (market.phase === "closed")
    return {
      kind: "closed",
      tone: "grey",
      icon: "ring",
      label: "Market closed",
      detail: market.next
        ? `· pre-market ${whenLabel(market.next.preStart, now)}`
        : "",
      heading: "Market closed · connected and waiting for the next session",
    };
  return {
    kind: "delayed",
    tone: "amber",
    icon: "warn",
    label: "Delayed",
    detail:
      last === null
        ? "· no bars yet"
        : `· last bar ${Math.floor((now - last) / 60000)} min ago`,
    heading:
      market.phase === "unknown"
        ? "No recent bars (date outside the exchange calendar)"
        : "Delayed · a US session is open but no recent bars arrived",
  };
}

// ------------------------------------------------------------------ alerts

export type LiveAlertRow = Evaluation & {
  close?: number;
  context?: { excess: number } | null;
  outcome?: { runUnits: number | null }; // backtest alerts only
  lookNow?: { score: number | null }; // backtest alerts only
};
export type DirectionFilter = "all" | "up" | "down";
// Backtest only: "score" = look-now score, "run" = best run in units,
// highest first.
export type AlertSort = "time" | "ratio" | "run" | "score";

export const alertDirection = (a: {
  direction: string | null;
  move: number;
}) =>
  a.direction === "down" || (a.direction === null && a.move < 0)
    ? "down"
    : "up";

/** Symbols by alert count, most first, then alphabetical. */
export function symbolCounts(alerts: { ticker: string }[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const a of alerts) counts.set(a.ticker, (counts.get(a.ticker) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

export function directionCounts<T extends LiveAlertRow>(
  alerts: T[],
  symbol: string | null,
) {
  const bySymbol = alerts.filter((a) => !symbol || a.ticker === symbol);
  const up = bySymbol.filter((a) => alertDirection(a) === "up").length;
  return { all: bySymbol.length, up, down: bySymbol.length - up };
}

export function filterAlerts<T extends LiveAlertRow>(
  alerts: T[],
  direction: DirectionFilter,
  symbol: string | null,
): T[] {
  return alerts.filter(
    (a) =>
      (!symbol || a.ticker === symbol) &&
      (direction === "all" || alertDirection(a) === direction),
  );
}

const sessionTitle = {
  pre: "Pre-market",
  regular: "Regular session",
  post: "After-hours",
};

export interface AlertGroup<T> {
  key: string;
  title: string; // session name; empty for the flat ratio list
  sub: string; // the session's Israel-time hours
  rows: T[];
}

export interface AlertDay<T> {
  day: string; // Israel calendar date, "2026-10-02"
  label: string; // "Fri 2 Oct"
  count: number;
  groups: AlertGroup<T>[];
}

/** US session date of an alert's window (the bar before its end). */
export const alertDate = (a: { end: string }) =>
  newYork(Date.parse(a.end) - 60000).date;

function sessionHours(date: string, session: keyof typeof sessionTitle) {
  const day = sessionDay(date);
  if (!day) return "";
  const [from, to] =
    session === "pre"
      ? [day.preStart, day.open]
      : session === "regular"
        ? [day.open, day.close]
        : [day.close, day.postEnd];
  return `${israelClock(from)}–${israelClock(to)}`;
}

/**
 * One group per Israel calendar date, newest first. Inside a day, newest
 * first splits into session groups (by US session date and session, so an
 * after-midnight after-hours stays separate); by ratio, score or run it is one flat list
 * (rows then carry a Pre/After tag in the UI).
 */
export function groupAlertDays<T extends LiveAlertRow>(
  alerts: T[],
  sort: AlertSort,
): AlertDay<T>[] {
  const rows = [...alerts].sort((a, b) =>
    sort === "ratio"
      ? (b.ratio ?? 0) - (a.ratio ?? 0) || b.end.localeCompare(a.end)
      : sort === "score"
        ? (b.lookNow?.score ?? -Infinity) - (a.lookNow?.score ?? -Infinity) ||
          b.end.localeCompare(a.end)
        : sort === "run"
          ? (b.outcome?.runUnits ?? -Infinity) -
              (a.outcome?.runUnits ?? -Infinity) || b.end.localeCompare(a.end)
          : b.end.localeCompare(a.end),
  );
  const days = new Map<string, T[]>();
  for (const a of rows) {
    const day = israelDate(Date.parse(a.end));
    days.set(day, [...(days.get(day) ?? []), a]);
  }
  return [...days.keys()]
    .sort()
    .reverse()
    .map((day) => {
      const inDay = days.get(day)!;
      const groups: AlertGroup<T>[] = [];
      if (sort !== "time")
        groups.push({ key: `${day}/all`, title: "", sub: "", rows: inDay });
      else
        for (const a of inDay) {
          const date = alertDate(a);
          const key = `${day}/${date}/${a.session}`;
          let group = groups.find((g) => g.key === key);
          if (!group) {
            group = {
              key,
              title: sessionTitle[a.session],
              sub: sessionHours(date, a.session),
              rows: [],
            };
            groups.push(group);
          }
          group.rows.push(a);
        }
      return {
        day,
        label: israelDayLabel(Date.parse(inDay[0]!.end)),
        count: inDay.length,
        groups,
      };
    });
}

// --------------------------------------------------------------- watchlist

// Board stats are optional (watchlist symbols only); absent fields show "—".
export const statsOf = (s: BoardSeries | undefined) => s?.stats;

/** % change of the last point from the previous close. */
export function boardChange(s: BoardSeries | undefined): number | null {
  const last = s?.points.at(-1)?.[1];
  return last !== undefined && s?.previousClose
    ? (last / s.previousClose - 1) * 100
    : null;
}

export type Compare = "SPY" | "sector";

export interface WatchRow {
  ticker: string;
  index: number; // watchlist order, the tie-breaker
  sector: string | null; // sector benchmark ETF
  against: string; // benchmark in use for the row
  last: number | null;
  change: number | null;
  benchChange: number | null;
  excess: number | null; // change − benchmark change, % points
  relVolume: number | null;
  rsScore: number | null; // score vs SPY 0–100, always against SPY
  dayLow: number | null;
  dayHigh: number | null;
  alerts: number;
}

export function watchRows(
  board: Board,
  alertCounts: Map<string, number>,
  compare: Compare,
): WatchRow[] {
  const bySymbol = new Map(board.series.map((s) => [s.ticker, s]));
  return board.watchlist.map((ticker, index) => {
    const s = bySymbol.get(ticker);
    const sector = board.benchmarks[ticker] ?? null;
    const against = compare === "sector" && sector ? sector : "SPY";
    const change = boardChange(s);
    const benchChange =
      against === ticker ? null : boardChange(bySymbol.get(against));
    const stats = statsOf(s);
    return {
      ticker,
      index,
      sector,
      against,
      last: s?.points.at(-1)?.[1] ?? null,
      change,
      benchChange,
      excess:
        change !== null && benchChange !== null ? change - benchChange : null,
      relVolume: stats?.relVolume ?? null,
      rsScore: stats?.rsScore ?? null,
      dayLow: stats?.dayLow ?? null,
      dayHigh: stats?.dayHigh ?? null,
      alerts: alertCounts.get(ticker) ?? 0,
    };
  });
}

/** Proposed thresholds: |change| ≥ 1% or rel vol ≥ 2×. */
export const moving = { change: 1, relVolume: 2 };
export const isMoving = (r: WatchRow) =>
  (r.change !== null && Math.abs(r.change) >= moving.change) ||
  (r.relVolume !== null && r.relVolume >= moving.relVolume);

export type WatchFilter = "all" | "moving" | "alerts";
export function filterRows(
  rows: WatchRow[],
  filter: WatchFilter,
  find: string,
): WatchRow[] {
  const q = find.trim().toUpperCase();
  return rows.filter(
    (r) =>
      (!q || r.ticker.startsWith(q)) &&
      (filter === "all" || (filter === "moving" ? isMoving(r) : r.alerts > 0)),
  );
}

export type WatchSort =
  | "ticker"
  | "last"
  | "change"
  | "excess"
  | "rsScore"
  | "relVolume"
  | "range"
  | "alerts";

/** Position of the last price within the day's range, 0 (low) to 1 (high). */
export function rangePosition(r: WatchRow): number | null {
  if (r.last === null || r.dayLow === null || r.dayHigh === null) return null;
  const span = r.dayHigh - r.dayLow;
  return span > 0 ? Math.min(1, Math.max(0, (r.last - r.dayLow) / span)) : 0.5;
}

const sortValue: Record<WatchSort, (r: WatchRow) => number | string | null> = {
  ticker: (r) => r.ticker,
  last: (r) => r.last,
  change: (r) => (r.change === null ? null : Math.abs(r.change)),
  excess: (r) => r.excess,
  rsScore: (r) => r.rsScore,
  relVolume: (r) => r.relVolume,
  range: rangePosition,
  alerts: (r) => r.alerts,
};

/** Default direction when a column is first chosen. */
export const sortsDescending = (key: WatchSort) => key !== "ticker";

/** Sorts by a column; missing values ("—") always go last. */
export function sortRows(
  rows: WatchRow[],
  key: WatchSort,
  descending: boolean,
): WatchRow[] {
  const value = sortValue[key];
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null || vb === null)
      return va === vb ? a.index - b.index : va === null ? 1 : -1;
    const c = va < vb ? -1 : va > vb ? 1 : 0;
    return (descending ? -c : c) || a.index - b.index;
  });
}
