// The Indi bot's news filter (docs/tasks/backend-indi-bot.md, "News filter"):
// no new entry on a stock's earnings reaction day, or when its pre-market
// volume is at least 4× normal. Matches news_filter.py of the V2 research,
// with the causal rule for reports without a time. Pure.

/** A row of the Nasdaq earnings calendar for one listed date. */
export interface EarningsReport {
  symbol: string;
  date: string; // the date the calendar lists it on
  time: string; // "time-pre-market", "time-after-hours", anything else: not supplied
}

export interface NewsCalendar {
  isSession(date: string): boolean;
  /** The first session strictly after `date`. */
  nextSession(date: string): string;
}

export interface NewsRules {
  gapPct: number; // a report without a time: today's open gap that makes it the reaction day
  preRatio: number; // pre-market volume vs normal that skips the stock
  preDays: number; // the sessions that make "normal"
  preMinDays: number; // sessions with data needed, else no pre-market filter
}

export const defaultNewsRules: NewsRules = {
  gapPct: 2,
  preRatio: 4,
  preDays: 20,
  preMinDays: 10,
};

/** Every calendar date whose report can make `today` a reaction day: the previous session through today. */
export function reportDates(today: string, previousSession: string): string[] {
  const out: string[] = [];
  for (
    let d = previousSession;
    d <= today;
    d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10)
  )
    out.push(d);
  return out;
}

/**
 * The report that makes `today` this stock's earnings reaction day, or null.
 * `gap(date)` is the session's absolute open gap vs the session before, as a
 * fraction (null when not known; it counts as 0, as in the research).
 */
export function reactionReport(
  reports: readonly EarningsReport[],
  today: string,
  calendar: NewsCalendar,
  gap: (date: string) => number | null,
  rules: NewsRules = defaultNewsRules,
): EarningsReport | null {
  const gapOf = (d: string) => gap(d) ?? 0;
  for (const r of reports) {
    const listedOnSession = calendar.isSession(r.date);
    const next = calendar.nextSession(r.date);
    if (r.time === "time-pre-market" && listedOnSession) {
      if (r.date === today) return r;
      continue;
    }
    if (r.time === "time-after-hours" || !listedOnSession) {
      if (next === today) return r;
      continue;
    }
    // No time: the day it is listed when that day gapped 2% or more,
    // else the next session when it gapped more than the listed day.
    if (r.date === today && gapOf(today) >= rules.gapPct / 100) return r;
    if (next === today && gapOf(today) > gapOf(r.date)) return r;
  }
  return null;
}

/**
 * Today's pre-market volume vs the median of the prior sessions that have
 * data. Null when today has none, or fewer than `preMinDays` prior sessions do.
 */
export function premarketRatio(
  today: number | null | undefined,
  prior: readonly (number | null | undefined)[],
  rules: NewsRules = defaultNewsRules,
): number | null {
  if (today === null || today === undefined) return null;
  const seen = prior
    .slice(-rules.preDays)
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);
  if (seen.length < rules.preMinDays) return null;
  const mid = Math.floor(seen.length / 2);
  const median =
    seen.length % 2 ? seen[mid]! : (seen[mid - 1]! + seen[mid]!) / 2;
  if (median <= 0) return null;
  return today / median;
}

/** Whether the pre-market volume skips the stock. */
export const premarketBlocks = (
  ratio: number | null,
  rules: NewsRules = defaultNewsRules,
) => ratio !== null && ratio >= rules.preRatio;
