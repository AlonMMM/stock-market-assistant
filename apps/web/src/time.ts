// Every user-facing time is shown in Israel time (docs/product.md#display-conventions).
export const israelZone = "Asia/Jerusalem";
export const israelLabel = "Israel time";

const dateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: israelZone,
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: israelZone,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const wallParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: israelZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const usDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "24 Sep, 16:35" in Israel time. */
export const israelDateTime = (ms: number) => dateTime.format(ms);
/** "16:35" in Israel time. */
export const israelClock = (ms: number) => clock.format(ms);

/**
 * Chart libraries render timestamps as UTC. Returns Unix seconds whose UTC
 * wall clock equals the Israel wall clock, so axes read in Israel time.
 */
export function israelWallSeconds(unixSeconds: number): number {
  const p = Object.fromEntries(
    wallParts.formatToParts(unixSeconds * 1000).map((x) => [x.type, x.value]),
  );
  return (
    Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
    ) / 1000
  );
}

/** US trading date (New York) that contains the instant. */
export const usSessionDate = (ms: number) => usDate.format(ms);

const weekday = new Intl.DateTimeFormat("en-GB", {
  timeZone: israelZone,
  weekday: "short",
});
const israelDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: israelZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
/** "Mon" in Israel time. */
export const israelWeekday = (ms: number) => weekday.format(ms);
/** Israel calendar date "2026-10-03" containing the instant. */
export const israelDate = (ms: number) => israelDay.format(ms);
