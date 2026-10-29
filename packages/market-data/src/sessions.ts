// The parts of a US trading day the charts show (user 2026-10-20: pre- and
// after-hours on the full screen, and the overnight session too). One trading
// date D owns, in time order:
//   pre-market 04:00–09:30, regular 09:30–close, after-hours close–20:00 New
//   York, then the overnight session (Blue Ocean ATS, Alpaca `feed=boats`)
//   from 20:00 until 04:00 of the next trading day.
// The overnight hours themselves come from overnight.ts (the night before a
// trading day; Friday and Saturday evenings have none). There the night
// belongs to the day it leads into, for the Watchlist's night change; on the
// charts it continues the day before.
import {
  coreClose,
  newYork,
  newYorkToUtc,
  previousSessions,
} from "./calendar.js";
import { overnightSession } from "./overnight.js";

export type SessionPart = "overnight" | "pre" | "regular" | "post";

const preOpen = 240; // 04:00
const regularOpen = 570; // 09:30
const afterClose = 1200; // 20:00
const day = 1440;

function trading(date: string): boolean {
  try {
    return coreClose(date) !== null;
  } catch {
    return false; // outside the calendar's years
  }
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The next trading date after `date`. */
export function nextSession(date: string): string {
  let next = addDays(date, 1);
  for (let i = 0; i < 10 && !trading(next); i++) next = addDays(next, 1);
  return next;
}

/**
 * The trading date and part of the day a moment belongs to; null when no
 * session trades then (a weekend, a holiday, Friday night).
 */
export function sessionAt(
  ms: number,
): { date: string; part: SessionPart; minute: number } | null {
  const { date, minute } = newYork(ms);
  if (trading(date) && minute >= preOpen && minute < afterClose) {
    const close = coreClose(date)!;
    return {
      date,
      minute,
      part: minute < regularOpen ? "pre" : minute < close ? "regular" : "post",
    };
  }
  // Overnight (overnight.ts): the night before a trading day, owned by the
  // trading date before that day.
  const night = overnightSession(ms);
  if (!night) return null;
  let owner: string;
  try {
    owner = previousSessions(night.date, 1)[0]!;
  } catch {
    return null;
  }
  return { date: owner, part: "overnight", minute };
}

/**
 * The bar of `minutes` length a moment falls in: its trading date and part,
 * a key that orders the bars of a date in time (pre < regular < after-hours <
 * overnight) and matches the same bar time on other dates (for volume
 * comparisons), and the bar's start (Unix s).
 * Bars line up on 09:30; a bar that would reach back over the start of its
 * part (the 04:00, 09:30, close or 20:00 boundary) starts at that boundary.
 */
export function barAt(
  ms: number,
  minutes: number,
): {
  date: string;
  part: SessionPart;
  key: number;
  start: number;
} | null {
  const s = sessionAt(ms);
  if (!s) return null;
  if (s.part === "overnight") {
    // Minutes since 20:00 of the evening this overnight began.
    const since = (s.minute - afterClose + day) % day;
    const index = Math.floor(since / minutes);
    const evening = Math.floor(ms / 60000) - since; // 20:00, as a UTC minute
    return {
      date: s.date,
      part: s.part,
      key: 100000 + index,
      start: (evening + index * minutes) * 60,
    };
  }
  const close = coreClose(s.date)!;
  const partStart =
    s.part === "pre" ? preOpen : s.part === "regular" ? regularOpen : close;
  const slot = Math.floor((s.minute - regularOpen) / minutes);
  const minute = Math.max(regularOpen + slot * minutes, partStart);
  return {
    date: s.date,
    part: s.part,
    // After-hours keys sit apart: a close that is not on a bar boundary
    // (16:00 on 1h bars) must not share the last regular bar's key.
    key: s.part === "post" ? 10000 + slot : slot,
    start: newYorkToUtc(s.date, minute) / 1000,
  };
}

/** The end of a date's overnight session: 04:00 of the next trading day (ms). */
export const overnightEnd = (date: string) =>
  newYorkToUtc(nextSession(date), preOpen);
