// The overnight session (Blue Ocean, Alpaca's BOATS feed): 20:00 to 04:00 New
// York, on the night before each US trading day, so Sunday night to Friday
// morning. The SIP feed stops at 20:00; these prints come only from BOATS
// (user 2026-10-26: "why we can't see night prices in our app").
import { coreClose, newYork, newYorkToUtc } from "./calendar.js";

export interface OvernightSession {
  // The trading day the night leads into (its pre-market opens at `end`).
  date: string;
  start: number; // 20:00 New York the evening before, Unix ms
  end: number; // 04:00 New York on `date`, Unix ms
}

const isSession = (date: string) => {
  try {
    return coreClose(date) !== null;
  } catch {
    return false; // outside the calendar's years
  }
};

const nextDay = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** The overnight session `time` falls in, or null outside 20:00–04:00 New York. */
export function overnightSession(time: number): OvernightSession | null {
  const { date, minute } = newYork(time);
  const leadsInto = minute >= 1200 ? nextDay(date) : minute < 240 ? date : null;
  if (leadsInto === null || !isSession(leadsInto)) return null;
  const evening = new Date(`${leadsInto}T12:00:00Z`);
  evening.setUTCDate(evening.getUTCDate() - 1);
  return {
    date: leadsInto,
    start: newYorkToUtc(evening.toISOString().slice(0, 10), 1200),
    end: newYorkToUtc(leadsInto, 240),
  };
}
