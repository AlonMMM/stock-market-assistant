export type Session = "pre" | "regular" | "post";
// Provider-normalized, CLOSED one-minute bars. session/date must come from
// the exchange calendar (including holidays and early closes).
export interface Bar {
  ticker: string;
  end: string;
  date: string;
  minute: number;
  session: Session;
  volume: number;
}
export interface Config {
  window: number;
  days: number;
  threshold: number;
  cooldown: number;
  minVolume: number;
}
export const defaults: Config = {
  window: 5,
  days: 20,
  threshold: 3,
  cooldown: 15,
  minVolume: 10000,
};
export interface Evaluation {
  ticker: string;
  end: string;
  session: Session;
  actual: number;
  expected: number | null;
  ratio: number | null;
  samples: number;
  status:
    | "insufficient-history"
    | "zero-baseline"
    | "below-threshold"
    | "low-volume"
    | "suppressed"
    | "alert";
  rule: "rvol-time-of-day-v1";
  config: Config;
}
export function validateConfig(c: Config) {
  for (const k of ["window", "days", "cooldown", "minVolume"] as const)
    if (
      !Number.isSafeInteger(c[k]) ||
      c[k] < (k === "minVolume" || k === "cooldown" ? 0 : 1)
    )
      throw new Error(`Invalid ${k}`);
  if (
    c.window > 60 ||
    c.days > 60 ||
    c.cooldown > 1440 ||
    !Number.isFinite(c.threshold) ||
    c.threshold <= 1
  )
    throw new Error("Invalid configuration");
}
export class RelativeVolume {
  private config: Config;
  private states = new Map<
    string,
    {
      last: number;
      bars: Bar[];
      history: Map<string, Map<number, number>>;
      above: boolean;
      alerted: number;
    }
  >();
  constructor(config: Config = defaults) {
    validateConfig(config);
    this.config = { ...config };
  }
  push(bar: Bar): Evaluation | null {
    const time = Date.parse(bar.end);
    if (
      !bar.ticker ||
      !Number.isFinite(time) ||
      time % 60000 !== 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(bar.date) ||
      !["pre", "regular", "post"].includes(bar.session) ||
      !Number.isInteger(bar.minute) ||
      bar.minute < 0 ||
      bar.minute > 1439 ||
      !Number.isSafeInteger(bar.volume) ||
      bar.volume < 0
    )
      throw new Error("Invalid closed bar");
    const key = `${bar.ticker}:${bar.session}`;
    const s = this.states.get(key) ?? {
      last: -Infinity,
      bars: [],
      history: new Map<string, Map<number, number>>(),
      above: false,
      alerted: -Infinity,
    };
    if (time <= s.last) throw new Error("Duplicate or out-of-order bar");
    const previous = s.bars.at(-1);
    if (
      previous &&
      (previous.date !== bar.date ||
        time - s.last !== 60000 ||
        bar.minute !== previous.minute + 1)
    ) {
      s.bars = [];
      s.above = false;
    }
    if (previous && previous.date !== bar.date) s.alerted = -Infinity;
    s.last = time;
    s.bars.push({ ...bar });
    if (s.bars.length > this.config.window) s.bars.shift();
    this.states.set(key, s);
    if (!s.history.has(bar.date)) s.history.set(bar.date, new Map());
    // Retain current date plus the last N observed session dates. Missing
    // windows on those dates are not replaced with older available samples.
    while (s.history.size > this.config.days + 1)
      s.history.delete(s.history.keys().next().value!);
    if (s.bars.length < this.config.window) return null;
    const actual = s.bars.reduce((sum, b) => sum + b.volume, 0);
    const values = [...s.history.entries()]
      .filter(([date]) => date < bar.date)
      .map(([, windows]) => windows.get(bar.minute))
      .filter((v): v is number => v !== undefined)
      .sort((a, b) => a - b);
    s.history.get(bar.date)!.set(bar.minute, actual);
    const expected =
      values.length === this.config.days
        ? (values[Math.floor((values.length - 1) / 2)]! +
            values[Math.floor(values.length / 2)]!) /
          2
        : null;
    const ratio = expected !== null && expected > 0 ? actual / expected : null;
    const crossing = ratio !== null && ratio >= this.config.threshold;
    let status: Evaluation["status"] =
      expected === null
        ? "insufficient-history"
        : expected === 0
          ? "zero-baseline"
          : !crossing
            ? "below-threshold"
            : actual < this.config.minVolume
              ? "low-volume"
              : s.above || time - s.alerted < this.config.cooldown * 60000
                ? "suppressed"
                : "alert";
    if (status === "alert") s.alerted = time;
    s.above = crossing;
    return {
      ticker: bar.ticker,
      end: bar.end,
      session: bar.session,
      actual,
      expected,
      ratio,
      samples: values.length,
      status,
      rule: "rvol-time-of-day-v1",
      config: { ...this.config },
    };
  }
}
export function replay(bars: Bar[], config: Config = defaults) {
  const engine = new RelativeVolume(config);
  return [...bars]
    .sort((a, b) => Date.parse(a.end) - Date.parse(b.end))
    .flatMap((b) => {
      const result = engine.push(b);
      return result ? [result] : [];
    });
}
