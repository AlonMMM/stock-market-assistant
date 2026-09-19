import {
  RelativeVolume,
  defaults,
  type Config,
} from "../../alerts/src/relative-volume.js";
import type { PriceBar } from "./bars.js";
import { previousSessions } from "./calendar.js";

export class LiveEvaluator {
  private engine: RelativeVolume;
  private coverage = new Set<string>();
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
      this.coverage = new Set(
        [...this.coverage].filter((k) => k.slice(0, 10) >= oldest),
      );
      this.date = bar.date;
    }
    this.last = bar.end;
    this.coverage.add(`${bar.date}:${bar.session}:${bar.minute}`);
    const result = this.engine.push(bar);
    if (
      !result ||
      !live ||
      now - Date.parse(bar.end) > 120000 ||
      Date.parse(bar.end) > now
    )
      return null;
    // Do not substitute older observed dates when a whole trading day is missing.
    const complete = this.dates.every((date) =>
      Array.from({ length: this.config.window }, (_, i) =>
        this.coverage.has(`${date}:${bar.session}:${bar.minute - i}`),
      ).every(Boolean),
    );
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
