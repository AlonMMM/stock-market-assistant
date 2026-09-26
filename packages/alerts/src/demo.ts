import { type Bar } from "./relative-volume.js";
export function demoBars(): Bar[] {
  const bars: Bar[] = [];
  let day = 0;
  for (let offset = 0; day < 21; offset++) {
    const date = new Date(Date.UTC(2026, 2, 2 + offset));
    if ([0, 6].includes(date.getUTCDay())) continue;
    day++;
    for (const ticker of ["AAPL", "NVDA", "MSFT"]) {
      for (let m = 0; m < 30; m++) {
        // March DST transition: 11:00 New York is 16:00 or 15:00 UTC.
        const hour = date.getUTCDate() < 8 ? 16 : 15;
        bars.push({
          ticker,
          date: date.toISOString().slice(0, 10),
          end: new Date(date.getTime() + (hour * 60 + m) * 60000).toISOString(),
          minute: 660 + m,
          session: "regular",
          volume:
            day === 21 && ticker === "NVDA" && m >= 10 && m < 20
              ? 50000
              : 10000,
        });
      }
    }
  }
  return bars;
}
