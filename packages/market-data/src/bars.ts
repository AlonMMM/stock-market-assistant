import type { Bar } from "../../alerts/src/relative-volume.js";
import { coreClose, newYork } from "./calendar.js";

export interface PriceBar extends Bar {
  open: number;
  high: number;
  low: number;
  close: number;
}
export interface RawBar {
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function normalize(
  ticker: string,
  raw: RawBar,
  volumeUnit: "shares" | "lots",
): PriceBar | null {
  if (
    !Number.isSafeInteger(raw.start) ||
    raw.start % 60 !== 0 ||
    ![raw.open, raw.high, raw.low, raw.close].every(
      (v) => Number.isFinite(v) && v > 0,
    ) ||
    raw.high < Math.max(raw.open, raw.close, raw.low) ||
    raw.low > Math.min(raw.open, raw.close)
  )
    throw new Error("Invalid market-data price bar");
  const volume = raw.volume * (volumeUnit === "lots" ? 100 : 1);
  if (!Number.isSafeInteger(volume) || volume < 0)
    throw new Error("Invalid market-data volume");
  const start = newYork(raw.start * 1000);
  const close = coreClose(start.date);
  // Extended sessions on shortened days vary by venue: exclude instead of guessing.
  if (
    close === null ||
    start.minute < 240 ||
    start.minute >= 1200 ||
    (close === 780 && start.minute >= close)
  )
    return null;
  return {
    ticker,
    end: new Date((raw.start + 60) * 1000).toISOString(),
    date: start.date,
    minute: start.minute + 1,
    session:
      start.minute < 570 ? "pre" : start.minute < close ? "regular" : "post",
    volume,
    open: raw.open,
    high: raw.high,
    low: raw.low,
    close: raw.close,
  };
}

// Repeated updates replace cumulative volume. A newer bar confirms the previous
// minute is closed; never finalize by a wall-clock timer during a broken stream.
export class ClosedMinutes {
  private pending?: RawBar;
  push(raw: RawBar): RawBar | null {
    const previous = this.pending;
    if (previous && raw.start < previous.start) return null;
    this.pending = { ...raw };
    return previous && raw.start > previous.start ? previous : null;
  }
}
