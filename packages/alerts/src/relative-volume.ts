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
  // v4 (user-confirmed 2026-10-03). Tag an alert "in play" when the symbol's
  // volume so far today (all sessions) is ≥ this × its median at the same
  // minute over `days` sessions. 0 turns the tag off; it never blocks.
  inPlayDayRvol: number;
  // N1, optional: the volume ratio ÷ max(1, today's volume level) must be ≥
  // this, so a busy day needs a bigger burst. 0 = off.
  todayVolumeMultiple: number;
  // N2, optional: |move| must be ≥ this × today's typical |move| over the
  // same window length (median over today's regular minutes before the
  // window; needs 15). 0 = off.
  todayMoveMultiple: number;
}
// The rule this evaluator implements. Bump it with any change to the alert
// conditions; stored alerts and cached backtests are keyed by it.
export const ruleVersion = "rvol-v4";

export const defaults: Config = {
  window: 3,
  days: 20,
  // 4× (was 3×) since 2026-10-05: about half the alerts, better look-now rate.
  threshold: 4,
  cooldown: 15,
  minVolume: 10000,
  priceMultiple: 3,
  minMovePercent: 0.5,
  // Off by default: a 0.5% gate cut alerts 6× and made them worse than
  // chance in validation (2026-09-27); kept as an opt-in setting.
  lastBarMinMovePercent: 0,
  // v4: one candle (was 3); the study kept quality with ~25% more alerts.
  directionBars: 1,
  paceMultiple: 4,
  paceMinMinutes: 15,
  paceSkipOpen: 30,
  paceSkipClose: 30,
  inPlayDayRvol: 2,
  todayVolumeMultiple: 0,
  todayMoveMultiple: 0,
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
  // v4: today's volume so far ÷ its median at this minute (null without ≥ 10
  // sessions), the in-play tag, and today's typical |move| (N2's yardstick).
  // Absent in alerts stored before v4.
  dayRvol?: number | null;
  inPlay?: boolean;
  todayMove?: number | null;
  status:
    | "insufficient-history"
    | "weak-last-bar"
    | "zero-baseline"
    | "below-threshold"
    | "low-volume"
    | "mixed-direction"
    | "small-move"
    | "busy-day-volume" // N1
    | "normal-for-today" // N2
    | "suppressed"
    | "alert";
  // Stored alerts keep the rule that produced them.
  rule: "rvol-v3" | "rvol-v4";
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
    c.paceSkipClose > 390 ||
    ![c.inPlayDayRvol, c.todayVolumeMultiple, c.todayMoveMultiple].every(
      (v) => Number.isFinite(v) && v >= 0 && v <= 100,
    )
  )
    throw new Error("Invalid configuration");
}
const median = (values: number[]) =>
  (values[Math.floor((values.length - 1) / 2)]! +
    values[Math.floor(values.length / 2)]!) /
  2;

// Relative volume v4 (user-confirmed 2026-10-03): v3 with one direction candle
// by default, an in-play tag, and optional today-normalized checks (N1, N2).
// v3 (2026-09-27): on each closed bar, over the
// last `window` bars: the last bar moved ≥ lastBarMinMovePercent from the
// previous close (else not evaluated); volume ≥ threshold × its time-of-day
// median OR ≥ paceMultiple × today's average window volume (mid-session only);
// price move (from the close before the window) ≥ priceMultiple × its
// time-of-day median |move| and ≥ minMovePercent; the last directionBars bars
// each close beyond the previous close with candles of that color. Alerts on a
// fresh crossing into that state, outside the cooldown.
// Per-symbol state across sessions, for today-relative measures.
interface DayState {
  date: string;
  cum: number; // volume so far today, all sessions
  minutes: Float64Array; // cumulative volume by minute today (NaN = no bar)
  closes: Float64Array; // regular-session closes by minute today
  // Previous sessions' cumulative volume by minute, forward-filled.
  past: Map<string, Float64Array>;
}

export class RelativeVolume {
  private config: Config;
  private days = new Map<string, DayState>();
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
    const day = this.today(bar);
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
    // Today-relative measures, only for bars that pass the cheaper checks.
    const candidate =
      lastOk &&
      volumeOk &&
      actual >= this.config.minVolume &&
      direction !== null &&
      moveOk;
    const dayRvol = candidate ? this.dayRvol(day, bar.minute) : null;
    const busyOk =
      c.todayVolumeMultiple === 0 ||
      (ratio ?? 0) / Math.max(1, dayRvol ?? 1) >= c.todayVolumeMultiple;
    const todayMove = candidate && busyOk ? this.todayMove(day, bar) : null;
    const todayOk =
      c.todayMoveMultiple === 0 ||
      todayMove === null ||
      Math.abs(move) >= c.todayMoveMultiple * todayMove;
    const signal = candidate && busyOk && todayOk;
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
                    : !busyOk
                      ? "busy-day-volume"
                      : !todayOk
                        ? "normal-for-today"
                        : s.above ||
                            time - s.alerted < this.config.cooldown * 60000
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
      dayRvol,
      inPlay:
        c.inPlayDayRvol > 0 && dayRvol !== null && dayRvol >= c.inPlayDayRvol,
      todayMove,
      status,
      rule: ruleVersion,
      config: { ...this.config },
    };
  }
  // Records the bar in its symbol's day; keeps `days` previous sessions.
  private today(bar: Bar): DayState {
    let d = this.days.get(bar.ticker);
    if (!d || d.date !== bar.date) {
      const past = d?.past ?? new Map<string, Float64Array>();
      if (d) {
        // Forward-fill the finished day so any minute reads its level.
        let level = 0;
        for (let m = 0; m < 1441; m++) {
          if (!Number.isNaN(d.minutes[m]!)) level = d.minutes[m]!;
          d.minutes[m] = level;
        }
        past.set(d.date, d.minutes);
        while (past.size > this.config.days)
          past.delete(past.keys().next().value!);
      }
      d = {
        date: bar.date,
        cum: 0,
        minutes: new Float64Array(1441).fill(NaN),
        closes: new Float64Array(1441).fill(NaN),
        past,
      };
      this.days.set(bar.ticker, d);
    }
    d.cum += bar.volume;
    d.minutes[bar.minute] = d.cum;
    if (bar.session === "regular") d.closes[bar.minute] = bar.close;
    return d;
  }
  private dayRvol(d: DayState, minute: number): number | null {
    const levels = [...d.past.values()].map((v) => v[minute]!);
    if (levels.length < 10) return null;
    const typical = median(levels.sort((a, b) => a - b));
    return typical > 0 ? d.cum / typical : null;
  }
  // Median |move| over `window` minutes across today's regular minutes that
  // end before this window starts; null with fewer than 15.
  private todayMove(d: DayState, bar: Bar): number | null {
    if (bar.session !== "regular") return null;
    const w = this.config.window;
    const moves: number[] = [];
    for (let m = 571 + w; m <= bar.minute - w; m++) {
      const a = d.closes[m]!;
      const b = d.closes[m - w]!;
      if (!Number.isNaN(a) && !Number.isNaN(b))
        moves.push(Math.abs((a / b - 1) * 100));
    }
    return moves.length >= 15 ? median(moves.sort((a, b) => a - b)) : null;
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
