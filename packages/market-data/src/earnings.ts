// Earnings badges on every ticker (user 2026-10-29): "Earnings today", "After
// earnings" (the first trading day after the report only) and "Earnings this
// week" (within the next 5 trading days). The dates come from the public
// Nasdaq earnings calendar, which the trading service already reads for the
// bot (apps/trader/src/bot-news.ts); the site reads them from it.
import { coreClose, newYork, previousSessions } from "./calendar.js";
import { nextSession } from "./sessions.js";

/** One row of the calendar: the date it lists the report on, and when. */
export interface EarningsRow {
  symbol: string;
  date: string;
  time: string; // "time-pre-market", "time-after-hours", or not supplied
}

export type EarningsTime = "before open" | "after close" | "";

/** `GET /api/earnings`: the reports of the dates around today, by symbol. */
export interface EarningsCalendar {
  from: string; // first calendar date read (the session before today)
  to: string; // last calendar date read (5 trading days ahead)
  reports: Record<string, { date: string; time: EarningsTime }[]>;
  missing: string[]; // dates that could not be read
  at: number; // when this was read (ms)
}

export type EarningsBadge = {
  kind: "today" | "after" | "week";
  date: string; // the report's date
  time: EarningsTime;
};

/** The trading days ahead that count as "this week". */
export const weekSessions = 5;

const trading = (date: string) => {
  try {
    return coreClose(date) !== null;
  } catch {
    return false; // outside the calendar's years
  }
};

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Today's trading date in New York, or the next one on a weekend or holiday. */
export function referenceSession(now: number): string {
  const { date } = newYork(now);
  return trading(date) ? date : nextSession(date);
}

/** The calendar dates to read: the session before today to 5 sessions ahead. */
export function earningsDates(now: number): string[] {
  const today = referenceSession(now);
  let last = today;
  for (let i = 0; i < weekSessions; i++) last = nextSession(last);
  const out: string[] = [];
  for (let d = previousSessions(today, 1)[0]!; d <= last; d = addDays(d, 1))
    out.push(d);
  return out;
}

const timeOf = (time: string): EarningsTime =>
  time === "time-pre-market"
    ? "before open"
    : time === "time-after-hours"
      ? "after close"
      : "";

/** Rows of several dates grouped by symbol, in date order. */
export function groupReports(rows: EarningsRow[]): EarningsCalendar["reports"] {
  const out: EarningsCalendar["reports"] = {};
  for (const r of [...rows].sort((a, b) => a.date.localeCompare(b.date)))
    (out[r.symbol] ??= []).push({ date: r.date, time: timeOf(r.time) });
  return out;
}

/**
 * The badge a symbol shows now: its report is today; or today is the first
 * trading day after its report; or it reports within the next 5 trading days.
 * Today counts first, then after, then this week.
 */
export function earningsBadge(
  reports: { date: string; time: EarningsTime }[] | undefined,
  now: number,
): EarningsBadge | null {
  if (!reports?.length) return null;
  const today = referenceSession(now);
  const on = reports.find((r) => r.date === today);
  if (on) return { kind: "today", ...on };
  // A report on a weekend or holiday leads into the next trading day.
  const after = reports.find(
    (r) => r.date < today && nextSession(r.date) === today,
  );
  if (after) return { kind: "after", ...after };
  let last = today;
  for (let i = 0; i < weekSessions; i++) last = nextSession(last);
  const ahead = reports.find((r) => r.date > today && r.date <= last);
  return ahead ? { kind: "week", ...ahead } : null;
}

/**
 * The trading service's cache of calendar days: a date is read again after
 * `freshMs`, a failed date after a minute. One read of a window asks only for
 * the dates it does not hold.
 */
export class EarningsCache {
  private days = new Map<string, { rows: EarningsRow[]; at: number }>();
  private failed = new Map<string, number>();
  constructor(
    private readonly readDay: (date: string) => Promise<EarningsRow[]>,
    private readonly freshMs = 6 * 3600_000,
  ) {}

  async window(now = Date.now()): Promise<EarningsCalendar> {
    const dates = earningsDates(now);
    const missing: string[] = [];
    await Promise.all(
      dates.map(async (date) => {
        const held = this.days.get(date);
        if (held && now - held.at < this.freshMs) return;
        const failedAt = this.failed.get(date);
        if (failedAt !== undefined && now - failedAt < 60_000) {
          if (!held) missing.push(date);
          return;
        }
        try {
          this.days.set(date, { rows: await this.readDay(date), at: now });
          this.failed.delete(date);
        } catch {
          this.failed.set(date, now);
          // An older copy still answers; without one the date is missing.
          if (!held) missing.push(date);
        }
      }),
    );
    for (const date of this.days.keys())
      if (!dates.includes(date)) this.days.delete(date);
    if (missing.length === dates.length)
      throw new Error("The earnings calendar could not be read");
    return {
      from: dates[0]!,
      to: dates.at(-1)!,
      reports: groupReports(dates.flatMap((d) => this.days.get(d)?.rows ?? [])),
      missing: missing.sort(),
      at: now,
    };
  }
}
