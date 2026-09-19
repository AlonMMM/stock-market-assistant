// Published US equity core-session calendar. Unknown years fail closed.
// Source: https://www.nyse.com/trade/hours-calendars (2026-09-19).
const holidays = new Set([
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
  "2026-11-27",
  "2026-12-24",
  "2027-11-26",
  "2028-07-03",
  "2028-11-24",
]);
export function coreClose(date: string): number | null {
  if (!/^202[678]-\d{2}-\d{2}$/.test(date))
    throw new Error("Calendar coverage is 2026–2028");
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
export function newYork(time: number) {
  const parts = Object.fromEntries(
    ny.formatToParts(time).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}
