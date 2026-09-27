import {
  RelativeVolume,
  defaults,
  type Config,
} from "../../alerts/src/relative-volume.js";
import type { PriceBar } from "./bars.js";
import { previousSessions } from "./calendar.js";

export class LiveEvaluator {
  private engine: RelativeVolume;
  // Observed minutes per "date:session", as a bitmap indexed by minute of day.
  private coverage = new Map<string, Uint8Array>();
  private last = "";
  private date = "";
  private dates: string[] = [];
  constructor(private config: Config = defaults) {
    this.engine = new RelativeVolume(config);
  }
  push(bar: PriceBar, now: number, live: boolean) {
    if (bar.end <= this.last) return null;
    if (bar.date !== this.date) {
      this.dates = previousSessions(bar.date, this.config.days);
      const oldest = this.dates[0]!;
      for (const key of this.coverage.keys())
        if (key.slice(0, 10) < oldest) this.coverage.delete(key);
      this.date = bar.date;
    }
    this.last = bar.end;
    const key = `${bar.date}:${bar.session}`;
    let minutes = this.coverage.get(key);
    if (!minutes) this.coverage.set(key, (minutes = new Uint8Array(1441)));
    minutes[bar.minute] = 1;
    const result = this.engine.push(bar);
    if (
      !result ||
      !live ||
      now - Date.parse(bar.end) > 120000 ||
      Date.parse(bar.end) > now
    )
      return null;
    // Do not substitute older observed dates when a whole trading day is missing.
    const complete = this.dates.every((date) => {
      const minutes = this.coverage.get(`${date}:${bar.session}`);
      if (!minutes) return false;
      for (let i = 0; i < this.config.window; i++)
        if (bar.minute - i < 0 || !minutes[bar.minute - i]) return false;
      return true;
    });
    return complete
      ? result
      : {
          ...result,
          status: "insufficient-history" as const,
          ratio: null,
          expected: null,
        };
  }
}
