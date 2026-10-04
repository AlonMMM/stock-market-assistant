// Published US equity core-session calendar. Unknown years fail closed.
// Source: https://www.nyse.com/trade/hours-calendars (2026-09-19); 2024–2025
// added 2026-09-27 for historical backtests, including the 2025-01-09 closure
// for the national day of mourning for President Carter.
const holidays = new Set([
  "2024-01-01",
  "2024-01-15",
  "2024-02-19",
  "2024-03-29",
  "2024-05-27",
  "2024-06-19",
  "2024-07-04",
  "2024-09-02",
  "2024-11-28",
  "2024-12-25",
  "2025-01-01",
  "2025-01-09",
  "2025-01-20",
  "2025-02-17",
  "2025-04-18",
  "2025-05-26",
  "2025-06-19",
  "2025-07-04",
  "2025-09-01",
  "2025-11-27",
  "2025-12-25",
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
  "2028-01-17",
  "2028-02-21",
  "2028-04-14",
  "2028-05-29",
  "2028-06-19",
  "2028-07-04",
  "2028-09-04",
  "2028-11-23",
  "2028-12-25",
]);
const early = new Set([
  "2024-07-03",
  "2024-11-29",
  "2024-12-24",
  "2025-07-03",
  "2025-11-28",
  "2025-12-24",
  "2026-11-27",
  "2026-12-24",
  "2027-11-26",
  "2028-07-03",
  "2028-11-24",
]);
export function coreClose(date: string): number | null {
  if (!/^202[4-8]-\d{2}-\d{2}$/.test(date))
    throw new Error("Calendar coverage is 2024–2028");
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6 || holidays.has(date)
    ? null
    : early.has(date)
      ? 780
      : 960;
}
export function previousSessions(date: string, count: number): string[] {
  const result: string[] = [];
  const cursor = new Date(`${date}T12:00:00Z`);
  while (result.length < count) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const d = cursor.toISOString().slice(0, 10);
    if (coreClose(d) !== null) result.unshift(d);
  }
  return result;
}
const ny = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
// New York's UTC offset only changes on whole UTC hours, so it is computed
// once per hour with Intl and reused; formatting every bar is the hot path.
const offsets = new Map<number, number>();
function offset(time: number): number {
  const hour = Math.floor(time / 3600000);
  let value = offsets.get(hour);
  if (value === undefined) {
    const at = hour * 3600000;
    const parts = Object.fromEntries(
      ny.formatToParts(at).map((p) => [p.type, p.value]),
    );
    const wall = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    value = wall - at;
    if (offsets.size > 100000) offsets.clear();
    offsets.set(hour, value);
  }
  return value;
}
export function newYork(time: number) {
  const wall = new Date(Math.floor(time / 60000) * 60000 + offset(time));
  return {
    date: wall.toISOString().slice(0, 10),
    minute: wall.getUTCHours() * 60 + wall.getUTCMinutes(),
  };
}

/** UTC milliseconds for a New York wall-clock minute on a date. */
export function newYorkToUtc(date: string, minute: number): number {
  const wall = Date.parse(`${date}T00:00:00Z`) + minute * 60000;
  // New York is UTC−4 (daylight) or UTC−5 (standard); pick the matching one.
  for (const hours of [4, 5]) {
    const utc = wall + hours * 3600000;
    const back = newYork(utc);
    if (back.date === date && back.minute === minute) return utc;
  }
  throw new Error("Invalid New York time");
}
