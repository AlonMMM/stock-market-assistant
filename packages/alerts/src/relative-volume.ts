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
  open: number;
  close: number;
  // New York minute the regular session closes that day (780 on early-close
  // days); 960 when absent.
  regularClose?: number;
}
export interface Config {
  window: number; // minutes in the evaluated window
  days: number; // previous sessions forming each baseline
  threshold: number; // volume ÷ median volume at this time of day
  cooldown: number; // minutes between alerts for a symbol
  minVolume: number; // shares in the window
  priceMultiple: number; // |move| ÷ median |move| at this time of day
  minMovePercent: number; // absolute |move| floor, percent
  // Last bar's close vs the previous close, percent; smaller moves are not
  // evaluated. 0 turns the gate off.
  lastBarMinMovePercent: number;
  directionBars: number; // last N window bars that must share one direction
  // Window volume ÷ today's average window volume ("today's pace"); either
  // this or `threshold` qualifies the volume. 0 turns the pace check off.
  paceMultiple: number;
  paceMinMinutes: number; // bars of today's pace zone needed before it applies
  paceSkipOpen: number; // minutes after the regular open outside the pace zone
  paceSkipClose: number; // minutes before the regular close outside it
}
export const defaults: Config = {
  window: 3,
  days: 20,
  threshold: 3,
  cooldown: 15,
  minVolume: 10000,
  priceMultiple: 3,
  minMovePercent: 0.5,
  // Off by default: a 0.5% gate cut alerts 6× and made them worse than
  // chance in validation (2026-09-27); kept as an opt-in setting.
  lastBarMinMovePercent: 0,
  directionBars: 3,
  paceMultiple: 3,
  paceMinMinutes: 15,
  paceSkipOpen: 30,
  paceSkipClose: 30,
};
export interface Evaluation {
  ticker: string;
  end: string;
  session: Session;
  actual: number;
  expected: number | null;
  ratio: number | null;
  // Window volume ÷ today's average window volume in the pace zone, if any.
  paceRatio: number | null;
  // Which comparison qualified the volume.
  volumeBasis: "history" | "pace" | "both" | null;
  // Percent change from the close before the window to its last close.
  move: number;
  // Median |move| for this symbol at this time of day over `days` sessions.
  expectedMove: number | null;
  direction: "up" | "down" | null;
  samples: number;
  status:
    | "insufficient-history"
    | "weak-last-bar"
    | "zero-baseline"
    | "below-threshold"
    | "low-volume"
    | "mixed-direction"
    | "small-move"
    | "suppressed"
    | "alert";
  rule: "rvol-v3";
  config: Config;
}
export function validateConfig(c: Config) {
  for (const k of [
    "window",
    "days",
    "cooldown",
    "minVolume",
    "directionBars",
    "paceMinMinutes",
    "paceSkipOpen",
    "paceSkipClose",
  ] as const)
    if (
      !Number.isSafeInteger(c[k]) ||
      c[k] <
        (["window", "days", "directionBars", "paceMinMinutes"].includes(k)
          ? 1
          : 0)
    )
      throw new Error(`Invalid ${k}`);
  if (
    c.window > 60 ||
    c.days > 60 ||
    c.cooldown > 1440 ||
    !Number.isFinite(c.threshold) ||
    c.threshold <= 1 ||
    !Number.isFinite(c.priceMultiple) ||
    c.priceMultiple < 1 ||
    !Number.isFinite(c.minMovePercent) ||
    c.minMovePercent < 0 ||
    c.minMovePercent > 100 ||
    c.directionBars > c.window ||
    !Number.isFinite(c.lastBarMinMovePercent) ||
    c.lastBarMinMovePercent < 0 ||
    c.lastBarMinMovePercent > 100 ||
    !Number.isFinite(c.paceMultiple) ||
    (c.paceMultiple !== 0 && c.paceMultiple <= 1) ||
    c.paceSkipOpen > 390 ||
    c.paceSkipClose > 390
  )
    throw new Error("Invalid configuration");
}
const median = (values: number[]) =>
  (values[Math.floor((values.length - 1) / 2)]! +
    values[Math.floor(values.length / 2)]!) /
  2;

// Relative volume v3 (user-confirmed 2026-09-27). On each closed bar, over the
// last `window` bars: the last bar moved ≥ lastBarMinMovePercent from the
// previous close (else not evaluated); volume ≥ threshold × its time-of-day
// median OR ≥ paceMultiple × today's average window volume (mid-session only);
// price move (from the close before the window) ≥ priceMultiple × its
// time-of-day median |move| and ≥ minMovePercent; the last directionBars bars
// each close beyond the previous close with candles of that color. Alerts on a
// fresh crossing into that state, outside the cooldown.
export class RelativeVolume {
  private config: Config;
  private states = new Map<
    string,
    {
      last: number;
      bars: Bar[];
      history: Map<string, Map<number, { volume: number; move: number }>>;
      above: boolean;
      alerted: number;
      // Today's pace zone so far: volume and bar count.
      pace: { date: string; volume: number; bars: number };
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
      bar.volume < 0 ||
      !(Number.isFinite(bar.open) && bar.open > 0) ||
      !(Number.isFinite(bar.close) && bar.close > 0)
    )
      throw new Error("Invalid closed bar");
    const key = `${bar.ticker}:${bar.session}`;
    const s = this.states.get(key) ?? {
      last: -Infinity,
      bars: [],
      history: new Map<string, Map<number, { volume: number; move: number }>>(),
      above: false,
      alerted: -Infinity,
      pace: { date: bar.date, volume: 0, bars: 0 },
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
    if (s.pace.date !== bar.date)
      s.pace = { date: bar.date, volume: 0, bars: 0 };
    // Pace zone: regular session, excluding the opening and closing minutes
    // whose volume is naturally far above the day's average.
    const c = this.config;
    const inPace = (b: Bar) =>
      b.session === "regular" &&
      b.minute > 570 + c.paceSkipOpen &&
      b.minute <= (b.regularClose ?? 960) - c.paceSkipClose;
    // Today's pace before this bar (window bars before this one excluded).
    const priorPace = { ...s.pace };
    if (inPace(bar)) {
      s.pace.volume += bar.volume;
      s.pace.bars++;
    }
    s.last = time;
    s.bars.push({ ...bar });
    // The window plus the bar before it, whose close anchors the move.
    if (s.bars.length > this.config.window + 1) s.bars.shift();
    this.states.set(key, s);
    if (!s.history.has(bar.date)) s.history.set(bar.date, new Map());
    // Retain current date plus the last N observed session dates. Missing
    // windows on those dates are not replaced with older available samples.
    while (s.history.size > this.config.days + 1)
      s.history.delete(s.history.keys().next().value!);
    if (s.bars.length < this.config.window + 1) return null;
    const before = s.bars[0]!;
    const window = s.bars.slice(1);
    const actual = window.reduce((sum, b) => sum + b.volume, 0);
    for (const b of window.slice(0, -1))
      if (inPace(b)) {
        priorPace.volume -= b.volume;
        priorPace.bars--;
      }
    const paceRatio =
      c.paceMultiple > 0 &&
      window.every(inPace) &&
      priorPace.bars >= c.paceMinMinutes &&
      priorPace.volume > 0
        ? actual / ((priorPace.volume / priorPace.bars) * c.window)
        : null;
    const last = window.at(-1)!;
    const lastMove = (last.close / (window.at(-2) ?? before).close - 1) * 100;
    const move = (window.at(-1)!.close / before.close - 1) * 100;
    const samples = [...s.history.entries()]
      .filter(([date]) => date < bar.date)
      .map(([, windows]) => windows.get(bar.minute))
      .filter((v) => v !== undefined);
    s.history.get(bar.date)!.set(bar.minute, {
      volume: actual,
      move: Math.abs(move),
    });
    const complete = samples.length === this.config.days;
    const expected = complete
      ? median(samples.map((v) => v.volume).sort((a, b) => a - b))
      : null;
    const expectedMove = complete
      ? median(samples.map((v) => v.move).sort((a, b) => a - b))
      : null;
    const ratio = expected !== null && expected > 0 ? actual / expected : null;
    const directed = s.bars.slice(-c.directionBars - 1);
    const closes = (up: boolean) =>
      directed.slice(1).every((b, i) => {
        const prior = directed[i]!.close;
        return up
          ? b.close > prior && b.close > b.open
          : b.close < prior && b.close < b.open;
      });
    const direction = closes(true) ? "up" : closes(false) ? "down" : null;
    const historyOk = ratio !== null && ratio >= this.config.threshold;
    const paceOk = paceRatio !== null && paceRatio >= c.paceMultiple;
    const volumeOk = historyOk || paceOk;
    const lastOk = Math.abs(lastMove) >= c.lastBarMinMovePercent;
    const moveOk =
      expectedMove !== null &&
      Math.abs(move) >= this.config.priceMultiple * expectedMove &&
      Math.abs(move) >= this.config.minMovePercent;
    const signal =
      lastOk &&
      volumeOk &&
      actual >= this.config.minVolume &&
      direction !== null &&
      moveOk;
    let status: Evaluation["status"] =
      expected === null
        ? "insufficient-history"
        : !lastOk
          ? "weak-last-bar"
          : expected === 0 && !paceOk
            ? "zero-baseline"
            : !volumeOk
              ? "below-threshold"
              : actual < this.config.minVolume
                ? "low-volume"
                : direction === null
                  ? "mixed-direction"
                  : !moveOk
                    ? "small-move"
                    : s.above || time - s.alerted < this.config.cooldown * 60000
                      ? "suppressed"
                      : "alert";
    if (status === "alert") s.alerted = time;
    s.above = signal;
    return {
      ticker: bar.ticker,
      end: bar.end,
      session: bar.session,
      actual,
      expected,
      ratio,
      paceRatio,
      volumeBasis: historyOk
        ? paceOk
          ? "both"
          : "history"
        : paceOk
          ? "pace"
          : null,
      move,
      expectedMove,
      direction,
      samples: samples.length,
      status,
      rule: "rvol-v3",
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
