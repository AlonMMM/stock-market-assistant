import {
  coreClose,
  newYork,
  previousSessions,
} from "../../../packages/market-data/src/calendar.js";

/** The US session whose chart is worth opening now: today's, or the last. */
export function chartSession(now = Date.now()): string {
  const { date, minute } = newYork(now);
  // Pre-market bars start at 04:00 New York.
  return coreClose(date) !== null && minute >= 240
    ? date
    : previousSessions(date, 1)[0]!;
}
