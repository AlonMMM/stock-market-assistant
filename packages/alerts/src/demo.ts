import { type Bar } from "./relative-volume.js";
// Synthetic: 21 weekdays of 11:00–11:29 New York bars for three symbols. Prices
// alternate by 0.05; on the last day NVDA climbs 0.4 a minute on 5× volume
// from 11:10 to 11:19.
export function demoBars(): Bar[] {
  const bars: Bar[] = [];
  let day = 0;
  for (let offset = 0; day < 21; offset++) {
    const date = new Date(Date.UTC(2026, 2, 2 + offset));
    if ([0, 6].includes(date.getUTCDay())) continue;
    day++;
    for (const ticker of ["AAPL", "NVDA", "MSFT"]) {
      let close = 100;
      for (let m = 0; m < 30; m++) {
        // March DST transition: 11:00 New York is 16:00 or 15:00 UTC.
        const hour = date.getUTCDate() < 8 ? 16 : 15;
        const spike = day === 21 && ticker === "NVDA" && m >= 10 && m < 20;
        const open = close;
        close = spike ? close + 0.4 : m % 2 ? 100.05 : 100;
        bars.push({
          ticker,
          date: date.toISOString().slice(0, 10),
          end: new Date(date.getTime() + (hour * 60 + m) * 60000).toISOString(),
          minute: 660 + m,
          session: "regular",
          volume: spike ? 50000 : 10000,
          open,
          close,
        });
      }
    }
  }
  return bars;
}
