import {
  bookAt,
  bsPrice,
  impliedDelta,
  newsBlock,
  premarketX,
  occSymbol,
  stockVol,
  strikeAt,
  yearsToExpiry,
  type BacktestCalendar,
  type BacktestData,
  type ChainContract,
  type QuoteMinute,
} from "../bot/backtest.js";
import { priorLevels } from "../bot/levels.js";
import type { MinuteBar } from "../bot/signal.js";
import type { OptionQuote } from "../options.js";
import { alerts, windows } from "./alert.js";
import {
  bestOf,
  burstAgrees,
  burstAtSecond,
  burstOf,
  againstWords,
  daysBetween,
  shockAgainstMove,
  shockRules,
  sideOf,
  type Leg,
} from "./decide.js";
import { shockKind } from "./fast.js";
import { legAt, legDeltas } from "./pick.js";
import type { StrangleSettings } from "./settings.js";

// The Volume bot's backtest for the app's Backtest page (the user, 2026-10-31:
// "good so lets open the volume for backtesting on the app"). One stock over
// a range of sessions, through the live bot's own rules (strangle/alert.ts,
// decide.ts, pick.ts): the plan's minute alert and the shock alert, the news
// filter, the expiry, the side on the stock's 1-second prices (the 15-second
// cross, the shock's 5 checks in a row within 300 s), the burst, the leg, and
// the give-back on minute closes. The account (size, limits, fees, one trade
// at a time a stock) is applied after, over every stock (volumeAccount), so
// changing the money needs no new run.
//
// Ported from the research simulator behind the live numbers (leg_seconds.py
// with leg_fallback.walk, leg_twice.pick and leg_daycap.account, research/
// indi-v2; the audited defaults STR_WALK_KEEP=1 STR_CHASE_NOFILL=ask):
// - the buy reads the contract's book 2 s after the side (the bot's reaction)
//   and pays the mid + a quarter of the spread; when the bid 10 s later is
//   already above that, the ask then (the live bot chases the ask);
// - the sale gets the bid as the exit minute closed;
// - fees $0.62 a contract each way.
// The research read 1-second books (Databento cbbo-1s); the app has those only
// where they were saved (optionSeconds), else the minute books (Databento
// cbbo-1m, option-quotes.ts) price the buy at the last minute closed before
// it, else the option's 1-minute bars (their middle ± fillPct). Each trade
// says which priced it.

/** A shock alert, precomputed from 10-second bars (scripts/shock-alerts.ts, the live fast.ts rule). */
export interface ShockAlert {
  date: string;
  second: number; // session second its 10-second slot ended (09:30 New York = 0)
  price: number; // the stock's close of that slot
  up: boolean;
}

/** A contract's book as session second `s` ended. */
export interface SecondBook {
  s: number;
  bid: number;
  ask: number;
}

/** What the Volume bot's backtest reads. Every call is for one stock's run. */
export interface VolumeBacktestData extends Pick<
  BacktestData,
  | "bars"
  | "premarket"
  | "chain"
  | "optionDay"
  | "optionQuotes"
  | "earnings"
  | "lastSession"
> {
  /**
   * The stock's last trade price each second from `from` to `to` (session
   * seconds), only the seconds that traded, oldest first.
   */
  stockSeconds(
    symbol: string,
    date: string,
    from: number,
    to: number,
  ): Promise<[number, number][]>;
  /** A contract's 1-second books from `from` to `to`; absent or empty: the minute books. */
  optionSeconds?(
    contract: string,
    date: string,
    from: number,
    to: number,
  ): Promise<SecondBook[]>;
  /** The stock's shock alerts over [from, to]. */
  /** A stock's shock alerts over [from, to], of one stored list (fast.ts shockKind). */
  shockAlerts(
    symbol: string,
    from: string,
    to: string,
    kind: string,
  ): Promise<ShockAlert[]>;
}

export type AlertKind = "plan" | "shock";

/** How a price was found: a 1-second book, a minute book, or the option's minute bars. */
export type PricedBy = "seconds" | "minutes" | "bars";

export type VolumeOutcome =
  | "traded"
  | "earnings"
  | "premarket"
  | "no_prices"
  | "no_expiry"
  | "no_side"
  | "slow_cross"
  | "burst"
  | "no_strikes"
  | "too_cheap"
  | "thin"
  | "wide_spread"
  | "no_fill"
  | "against_move";

/** One trade: the leg bought at the side and sold on the give-back or the end. */
export interface VolumeTrade {
  contract: string;
  right: Leg;
  strike: number;
  expiry: string;
  delta: number;
  fallback: string; // another strike than the delta's, in words; "" when none
  sideSecond: number; // the side: the first second (plan) or the 5th check in a row (shock)
  toSide: number; // seconds from the alert to the side
  stockIn: number; // the stock at the side
  buyMinute: number; // the side's minute: the walk starts there
  buy: number;
  book: { bid: number; ask: number } | null; // the book the buy read
  spread: number | null; // (ask - bid) / mid of that book
  buyPriced: PricedBy;
  exitMinute: number;
  exitReason: "giveback" | "end" | "stop";
  sell: number;
  sellPriced: PricedBy;
  stockOut: number | null;
  volume30?: number | null; // contracts of the leg traded in the 30 minutes before the pick (absent on older runs)
}

/**
 * An alert not traded, as it would have traded: the side crossed, else the
 * alert's way; the same give-back walk. Priced from the saved books when they
 * hold the bot's leg at the buy and at the sale ("book": the leg the bot picks,
 * bought at the ask, sold at the bid), else by a model ("model": the strike at
 * the bot's delta, Black-Scholes at the stock's volatility). The model is far
 * too cheap on a day of a big move (DELL 2026-05-08: the 250 call $0.23 by the
 * model, $3.75 on the book), so it is the fallback. No fees, no broker stop.
 */
export interface VolumeWhatIf {
  priced?: "book" | "model"; // absent on older runs: the model
  contract: string;
  right: Leg;
  strike: number;
  expiry: string;
  sideSecond: number | null; // the side's second; null: no side, the alert's way at the alert
  buyMinute: number;
  exitMinute: number;
  exitReason: "giveback" | "end";
  stockIn: number;
  stockOut: number;
  buy: number;
  sell: number;
  iv: number; // the stock's volatility, annualised
  ret: number;
}

/** One alert of the run and what came of it. */
export interface VolumeSignal {
  id: string; // symbol|date|kind|second
  symbol: string;
  date: string;
  kind: AlertKind;
  minute: number; // the alert's minute
  second: number; // the alert's second: a minute alert at its minute's close
  alert: "up" | "down";
  price: number | null; // the side lines' start
  unit: number | null; // the stock's typical 30-minute move, a fraction
  burst: number | null;
  // Pre-market volume (04:00-09:30) vs the median of the 20 sessions before,
  // the stock's and SPY's (news.ts premarketRatio); null without the data.
  premarketX?: number | null;
  spyPremarketX?: number | null;
  expiry: string | null;
  outcome: VolumeOutcome;
  detail: string;
  trade?: VolumeTrade;
  // How far the stock got toward a side line within the cross window (the
  // shock's touch window), the nearer line's share: 1 = on the line. Only when
  // the stock's seconds were read.
  reach?: number;
  // The longest stretch of the decision window (the shock's touch window, the
  // plan's cross window) with no stock price, session seconds, when it is at
  // least DATA_GAP_SECONDS: the saved seconds may miss trades there, so the
  // outcome is flagged, not changed (the user, 2026-11-06: "just add a proper
  // error for me to be able to see it and fix it later").
  dataGap?: { from: number; to: number };
  whatIf?: VolumeWhatIf; // an alert not traded, when a model can price it
  // A side too slow: whether the burst would have passed toward the side the
  // what-if took, and the burst it needs (the user, 2026-11-07: the slow sides
  // are mostly a weak burst too).
  slowBurst?: { passes: boolean; need: number };
}

/** A stretch this long with no stock price in an alert's decision window is flagged. */
export const DATA_GAP_SECONDS = 10;

export interface VolumeStockRun {
  symbol: string;
  signals: VolumeSignal[];
  // Settings the backtest cannot replay, so it left them out.
  ignored: (keyof StrangleSettings)[];
}

export interface VolumeRunOptions {
  /** The option bars' fill when no book prices a trade: the middle ± this %. */
  fillPct: number;
  /** No book at the buy or the sale: no trade (the research simulator's way), not the bars. */
  strictQuotes?: boolean;
  /**
   * The broker's safety stop the live bot sends with every buy (stopPct
   * safetyStopPct): the first minute book whose bid is at or under the buy
   * less safetyStopPct sells at that bid, before the give-back or the end.
   */
  safetyStop?: boolean;
  /** The day's alerts instead of the computed ones (the parity check reads the research's). */
  alerts?: (
    symbol: string,
    date: string,
  ) => { kind: AlertKind; second: number; price: number; up: boolean }[];
  /** The news filter's verdict instead of the calendar's (the parity check reads the research's). */
  news?: (
    symbol: string,
    date: string,
  ) => { reason: "earnings" | "premarket"; detail: string } | null;
}

export const defaultVolumeFillPct = 2;
const priorDays = 20;
const lag = 2; // seconds from the side to the buy (the bot's reaction)
const chaseAfter = 10; // seconds: a bid above the price by then means no fill at it
const barMaxAge = 10; // minutes: the last bar a strike's price is read from
const bookMaxAge = 10; // seconds: the oldest 1-second book a strike's pick reads
const firstPrint = 3; // minutes after the side the walk waits for the option's first trade

/** The last bar at or before `minute`, no older than `age` minutes. */
function lastBar(
  bars: readonly MinuteBar[],
  minute: number,
  age = 390,
): MinuteBar | null {
  let best: MinuteBar | null = null;
  for (const b of bars) if (b.m <= minute) best = b;
  return best && minute - best.m < age ? best : null;
}

const mid = (b: MinuteBar) => (b.h + b.l) / 2;

/** The last session of the date's week (Friday, or earlier on a holiday). */
function weekEnd(date: string, cal: BacktestCalendar): string {
  const d = new Date(`${date}T12:00:00Z`);
  let end = new Date(d.getTime() + (5 - d.getUTCDay()) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  while (end > date && cal.sessionLength(end) === null)
    end = new Date(Date.parse(`${end}T12:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
  return end;
}

/** The day's expiry as the live bot finds it: today's, the next session's, else later this week. */
async function expiryFor(
  data: VolumeBacktestData,
  cal: BacktestCalendar,
  symbol: string,
  date: string,
  s: StrangleSettings,
): Promise<string | null> {
  const next = cal.nextSessions(date, 1)[0]!;
  const chain = await data.chain(symbol, "call", date, s.nextDay ? next : date);
  if (chain.some((c) => c.expiry === date)) return date;
  if (s.nextDay && chain.some((c) => c.expiry === next)) return next;
  if (!s.weekExpiry) return null;
  const end = weekEnd(date, cal);
  if (end <= next) return null;
  const week = await data.chain(symbol, "call", next, end);
  const later = [...new Set(week.map((c) => c.expiry))]
    .filter((e) => e > next && e <= end)
    .sort();
  return later[0] ?? null;
}

/** The newest book at or before second `s`. */
function bookAtSecond(
  rows: readonly SecondBook[],
  s: number,
): SecondBook | null {
  let best: SecondBook | null = null;
  for (const r of rows) if (r.s <= s) best = r;
  return best;
}

/** The first minute after the buy, up to `last`, whose book's bid is at or under `stop`. */
function stopHit(
  day: readonly QuoteMinute[],
  buyMinute: number,
  last: number,
  stop: number,
): QuoteMinute | null {
  for (const q of day)
    if (q.m > buyMinute && q.m < last && q.bid <= stop) return q;
  return null;
}

/** The side: the first second past a line (plan), or the 5th check in a row on one side (shock). */
/**
 * The side from the stock's seconds since the alert: a minute alert's first
 * second beyond a line; a shock's 5 traded seconds in a row on one side. The
 * live bot decides with this too (apps/trader/src/strangle.ts crossedSince).
 */
export function findSide(
  seconds: readonly [number, number][],
  stock0: number,
  unit: number,
  s: StrangleSettings,
  shock: boolean,
): { second: number; side: Leg; price: number } | null {
  let run = 0;
  let runSide: Leg | null = null;
  for (const [sec, price] of seconds) {
    const side = sideOf(price, stock0, unit, s);
    if (!shock) {
      if (side) return { second: sec, side, price };
      continue;
    }
    if (side && side === runSide) run++;
    else if (side) {
      run = 1;
      runSide = side;
    } else {
      run = 0;
      runSide = null;
    }
    if (side && run >= shockRules.holdChecks)
      return { second: sec, side, price };
  }
  return null;
}

interface Buy {
  buy: number;
  book: { bid: number; ask: number } | null;
  spread: number | null;
  priced: PricedBy;
}

/**
 * The buy at the side's second + 2 (leg_seconds.trade): the mid + a quarter
 * of the spread; the ask 10 s later when the bid then is already above it.
 */
function buyFrom(
  q: { bid: number; ask: number },
  later: { bid: number; ask: number } | null,
  priced: PricedBy,
): Buy {
  const m = (q.bid + q.ask) / 2;
  let buy = m + (q.ask - m) / 2;
  if (later && later.bid > buy) buy = later.ask;
  return {
    buy,
    book: { bid: q.bid, ask: q.ask },
    spread: (q.ask - q.bid) / m,
    priced,
  };
}

async function priceBuy(
  data: VolumeBacktestData,
  contract: string,
  date: string,
  sec: number,
  quotes: readonly QuoteMinute[],
  bars: readonly MinuteBar[],
  o: VolumeRunOptions,
): Promise<Buy | null> {
  const t = sec + lag;
  if (data.optionSeconds) {
    const rows = (
      await data
        .optionSeconds(contract, date, sec - lag, t + chaseAfter)
        .catch(() => [])
    ).filter((r) => r.bid > 0 && r.ask > 0);
    if (rows.length) {
      const q = bookAtSecond(rows, t);
      if (q) return buyFrom(q, bookAtSecond(rows, t + chaseAfter), "seconds");
      if (o.strictQuotes) return null;
    } else if (o.strictQuotes) return null;
  }
  // The last minute closed at the buy, and the next minute's for the chase.
  const m = Math.floor(t / 60) - 1;
  const q = bookAt(quotes, m);
  if (q && q.bid > 0 && q.ask > 0) {
    const later = bookAt(quotes, m + 1);
    return buyFrom(q, later && later.bid > 0 ? later : null, "minutes");
  }
  if (o.strictQuotes) return null;
  const ct = Math.floor(sec / 60);
  const b = bars.find((x) => x.m >= ct && x.m <= ct + firstPrint);
  if (!b) return null;
  return {
    buy: mid(b) * (1 + o.fillPct / 100),
    book: null,
    spread: null,
    priced: "bars",
  };
}

/**
 * The give-back on minute closes (leg_fallback.walk): from the option's first
 * print within 3 minutes of the side (the side's minute when none), the best
 * starts at the stock at the side and takes each minute's close; under
 * noStopMinutes only the best moves; the first close giveBackUnits back sells,
 * else the end minute.
 */
function walkExit(
  stock: readonly MinuteBar[],
  option: readonly MinuteBar[],
  ct: number,
  side: Leg,
  stockIn: number,
  unit: number,
  end: number,
  s: StrangleSettings,
): { minute: number; reason: "giveback" | "end" } {
  const b0 = option.find((b) => b.m >= ct && b.m <= ct + firstPrint)?.m ?? ct;
  const closes = new Map(stock.map((b) => [b.m, b.c]));
  let best = stockIn;
  for (let t = b0 + 1; t <= end; t++) {
    const spot = closes.get(t);
    if (spot) best = bestOf(best, spot, side);
    if (s.noStopMinutes && t - b0 <= s.noStopMinutes && t < end) continue;
    if (t >= end) return { minute: t, reason: "end" };
    if (spot && Math.abs(spot / best - 1) >= s.giveBackUnits * unit)
      return { minute: t, reason: "giveback" };
  }
  return { minute: end, reason: "end" };
}

/**
 * The strikes of the leg's side and expiry as quotes, delta by Black-Scholes:
 * each strike's 1-second book at the buy second `at` when one was saved (the
 * chain the live bot reads then), else its last price by `minute`, the last
 * whole minute before the buy. On a fast move the minute before is stale: META
 * 2026-06-05 14:12:56, the 600 put was $0.05 at 14:11 and about $1 at the buy,
 * so the minute before read "too cheap" (the user, 2026-11-06).
 */
async function chainQuotes(
  data: VolumeBacktestData,
  symbol: string,
  date: string,
  minute: number,
  right: Leg,
  spot: number,
  expiry: string,
  at: number,
): Promise<{ quotes: OptionQuote[]; bars: Map<string, MinuteBar[]> }> {
  const side = right === "C" ? "call" : "put";
  const call = right === "C";
  const chain: ChainContract[] = await data.chain(symbol, side, expiry, expiry);
  const near = chain
    .filter((c) => c.expiry === expiry)
    .filter((c) =>
      call
        ? spot <= c.strike && c.strike <= spot * 1.2
        : spot * 0.8 <= c.strike && c.strike <= spot,
    )
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
    .slice(0, 16);
  const bars = near.length
    ? await data.optionDay(
        near.map((c) => c.symbol),
        date,
      )
    : new Map<string, MinuteBar[]>();
  const years = yearsToExpiry(date, minute, expiry);
  const atYears = yearsToExpiry(date, Math.floor(at / 60), expiry);
  const books = await Promise.all(
    near.map((c) => bookAtBuy(data, c.symbol, date, at)),
  );
  const quotes: OptionQuote[] = [];
  near.forEach((c, i) => {
    const book = books[i];
    let price: number;
    let bid: number;
    let ask: number;
    let t = years;
    if (book) {
      price = (book.bid + book.ask) / 2;
      bid = book.bid;
      ask = book.ask;
      t = atYears;
    } else {
      const b = lastBar(bars.get(c.symbol) ?? [], minute, barMaxAge);
      if (!b) return;
      price = b.c;
      bid = b.c;
      ask = b.c;
    }
    const delta = impliedDelta(price, spot, c.strike, t, call);
    if (delta === null) return;
    quotes.push({
      symbol: c.symbol,
      underlying: symbol,
      expiry,
      right: side,
      strike: c.strike,
      bid,
      ask,
      delta: call ? delta : -delta,
    });
  });
  return { quotes, bars };
}

/** A contract's saved 1-second book at second `at`, at most bookMaxAge old; null without one. */
async function bookAtBuy(
  data: VolumeBacktestData,
  contract: string,
  date: string,
  at: number,
): Promise<SecondBook | null> {
  if (!data.optionSeconds) return null;
  const rows = (
    await data
      .optionSeconds(contract, date, at - bookMaxAge, at)
      .catch(() => [])
  ).filter((r) => r.bid > 0 && r.ask > 0);
  return bookAtSecond(rows, at);
}

/** The day's alerts in time order: the plan's fresh minute alerts and the shock's. */
function dayAlerts(
  symbol: string,
  date: string,
  bars: readonly MinuteBar[],
  hist: () => ReturnType<typeof windows>[], // the 20 prior sessions' windows, read only when needed
  shocks: readonly ShockAlert[],
  s: StrangleSettings,
  last: number,
  o: VolumeRunOptions,
): { kind: AlertKind; second: number; price: number; up: boolean }[] {
  if (o.alerts) return o.alerts(symbol, date);
  const out: { kind: AlertKind; second: number; price: number; up: boolean }[] =
    [];
  const sides = alerts(bars, hist());
  const closes = new Map(bars.map((b) => [b.m, b.c]));
  let first = true;
  for (let m = s.firstMinute; m <= Math.min(s.lastMinute, last); m++) {
    const side = sides[m];
    if (!side) continue;
    // A new burst at m: an alert now and none the minute before; the day's
    // first counts from firstMinute (strangle.ts entries).
    const fresh = first || !sides[m - 1];
    first = false;
    const price = closes.get(m);
    if (!fresh || price === undefined) continue;
    out.push({ kind: "plan", second: (m + 1) * 60, price, up: side === "up" });
  }
  if (s.shockAlert)
    for (const a of shocks)
      if (a.date === date)
        out.push({ kind: "shock", second: a.second, price: a.price, up: a.up });
  return out.sort((a, b) => a.second - b.second);
}

/** The Volume bot over one stock and a range of sessions. */
export async function runVolumeStock(
  symbol: string,
  dates: readonly string[],
  s: StrangleSettings,
  data: VolumeBacktestData,
  cal: BacktestCalendar,
  o: VolumeRunOptions = { fillPct: defaultVolumeFillPct },
): Promise<VolumeStockRun> {
  const ignored: (keyof StrangleSettings)[] = [];
  if (s.fastAlert) ignored.push("fastAlert");
  if (s.strengthFilter) ignored.push("strengthFilter");
  const signals: VolumeSignal[] = [];
  const shocks =
    s.shockAlert && !o.alerts && dates.length
      ? await data.shockAlerts(
          symbol,
          dates[0]!,
          dates.at(-1)!,
          shockKind(s.shockPaceMin),
        )
      : [];
  for (const date of dates) {
    const length = cal.sessionLength(date);
    const bars = data.bars(symbol, date);
    if (length === null || !bars.length) continue;
    const prior = cal.previousSessions(date, priorDays);
    const day = dayAlerts(
      symbol,
      date,
      bars,
      () => prior.map((d) => windows(data.bars(symbol, d))),
      shocks,
      s,
      length - 1,
      o,
    );
    if (!day.length) continue;
    const unit =
      priorLevels(prior.slice(-5).map((d) => data.bars(symbol, d)))?.unit ??
      null;
    const end = Math.min(s.endMinute, length - 30);
    const news = o.news
      ? o.news(symbol, date)
      : await newsBlock(symbol, date, s, data, cal);
    const pre = {
      premarketX: premarketX(symbol, date, data, cal),
      spyPremarketX: premarketX("SPY", date, data, cal),
    };
    let expiry: string | null | undefined;
    const first = signals.length;
    const sides = new Map<
      VolumeSignal,
      { second: number; side: Leg; price: number }
    >();
    for (const a of day) {
      const minute = Math.floor(a.second / 60) - (a.kind === "plan" ? 1 : 0);
      const shock = a.kind === "shock";
      const signal: VolumeSignal = {
        id: `${symbol}|${date}|${a.kind}|${a.second}`,
        symbol,
        date,
        kind: a.kind,
        minute,
        second: a.second,
        alert: a.up ? "up" : "down",
        price: a.price,
        unit,
        ...pre,
        burst: null,
        expiry: null,
        outcome: "no_prices",
        detail: "",
      };
      signals.push(signal);
      const done = (outcome: VolumeOutcome, detail = "") => {
        signal.outcome = outcome;
        signal.detail = detail;
      };
      if (news) {
        done(news.reason, news.detail);
        continue;
      }
      if (!unit) {
        done("no_prices", "fewer than 5 sessions of history");
        continue;
      }
      // No shock against the day's move (Volume 1.2.0), from the 09:30 bar's open.
      const against = shock
        ? shockAgainstMove(
            a.price,
            bars.find((b) => b.m === 0)?.o,
            unit,
            a.up,
            s,
          )
        : null;
      if (against !== null) {
        done("against_move", againstWords(against));
        continue;
      }
      if (expiry === undefined)
        expiry = await expiryFor(data, cal, symbol, date, s);
      signal.expiry = expiry;
      if (!expiry) {
        done("no_expiry");
        continue;
      }
      if (shock && daysBetween(date, expiry) > shockRules.maxDays) {
        done(
          "no_expiry",
          "the shock alert trades an expiry at most 2 days out",
        );
        continue;
      }
      signal.burst = shock
        ? burstAtSecond(bars, a.second, a.price, unit)
        : burstOf(bars, minute, unit);
      // The side: within crossMaxSeconds with the cross filter (the shock:
      // 5 checks in a row within 300 s), else within the wait.
      let within = s.waitMinutes * 60;
      if (s.crossFilter) within = s.crossMaxSeconds;
      if (shock) within = shockRules.holdWithin;
      const seconds = await data.stockSeconds(
        symbol,
        date,
        a.second,
        a.second + within,
      );
      const decideBy = a.second + (shock ? s.shockTouchSeconds : within);
      signal.reach = reachOf(seconds, decideBy, a.price, unit, s);
      const gap = longestGap(seconds, a.second, decideBy);
      if (gap) signal.dataGap = gap;
      // The shock: a side line touched within shockTouchSeconds, as the live bot.
      if (
        shock &&
        !seconds.some(
          ([sec, price]) =>
            sec <= a.second + s.shockTouchSeconds &&
            sideOf(price, a.price, unit, s),
        )
      ) {
        done(
          "slow_cross",
          `no side line within ${s.shockTouchSeconds} s of the alert`,
        );
        continue;
      }
      const side = findSide(
        seconds.filter(([sec]) => sec <= a.second + within),
        a.price,
        unit,
        s,
        shock,
      );
      if (!side) {
        done(s.crossFilter || shock ? "slow_cross" : "no_side");
        continue;
      }
      sides.set(signal, side);
      const weekly = !shock && expiry > cal.nextSessions(date, 1)[0]!;
      let burstRule: Pick<StrangleSettings, "burstFilter" | "burstMin"> = s;
      if (weekly) burstRule = { ...s, burstMin: s.burstMinWeek };
      if (shock) burstRule = { burstFilter: true, burstMin: 0 };
      if (!burstAgrees(side.side, signal.burst, burstRule)) {
        done(
          "burst",
          `burst ${signal.burst === null ? "—" : signal.burst.toFixed(2)}×${weekly ? ` (a same-week expiry needs ${s.burstMinWeek})` : ""}`,
        );
        continue;
      }
      // The leg on the last whole minute before the buy, as the research picked it.
      const cm = Math.floor(side.second / 60) - 1;
      const right = side.side === "C" ? "call" : "put";
      const { quotes, bars: optionBars } = await chainQuotes(
        data,
        symbol,
        date,
        cm,
        side.side,
        side.price,
        expiry,
        side.second + lag,
      );
      const volume30 = async (contract: string) =>
        (optionBars.get(contract) ?? [])
          .filter((b) => cm - 30 < b.m && b.m <= cm)
          .reduce((sum, b) => sum + b.v, 0);
      let leg: Awaited<ReturnType<typeof legAt>> | null = null;
      for (const delta of legDeltas(s, shock)) {
        leg = await legAt(
          quotes,
          side.price,
          right,
          date,
          daysBetween(date, expiry),
          delta,
          s,
          volume30,
          (c) => c,
        );
        if (leg.ok) break;
      }
      if (!leg || !leg.ok) {
        const why = leg?.outcome ?? "no_prices";
        const known: VolumeOutcome[] = ["no_strikes", "too_cheap", "thin"];
        done(
          known.includes(why as VolumeOutcome)
            ? (why as VolumeOutcome)
            : "no_prices",
          leg?.detail ?? "",
        );
        continue;
      }
      const contract = leg.quote.symbol;
      const legBars = optionBars.get(contract) ?? [];
      const dayQuotes = data.optionQuotes
        ? ((
            await data
              .optionQuotes(contract, date, date)
              .catch(() => new Map<string, QuoteMinute[]>())
          ).get(date) ?? [])
        : [];
      const bought = await priceBuy(
        data,
        contract,
        date,
        side.second,
        dayQuotes,
        legBars,
        o,
      );
      if (!bought) {
        done("no_fill", "no book at the buy");
        continue;
      }
      if (
        shock &&
        (bought.spread === null || bought.spread > shockRules.maxSpread)
      ) {
        done(
          "wide_spread",
          bought.spread === null
            ? "no book to check the spread"
            : `${(bought.spread * 100).toFixed(0)}% of the mid`,
        );
        continue;
      }
      const ct = Math.floor(side.second / 60);
      const exit = walkExit(
        bars,
        legBars,
        ct,
        side.side,
        side.price,
        unit,
        end,
        s,
      );
      const stopped = o.safetyStop
        ? stopHit(
            dayQuotes,
            ct,
            exit.minute,
            bought.buy * (1 - s.safetyStopPct / 100),
          )
        : null;
      const exitMinute = stopped?.m ?? exit.minute;
      const exitReason = stopped ? "stop" : exit.reason;
      const sale = stopped ?? bookAt(dayQuotes, exitMinute);
      let sell: number | null = null;
      let sellPriced: PricedBy = "minutes";
      if (sale) sell = sale.bid;
      else if (!o.strictQuotes) {
        const b = lastBar(legBars, exitMinute);
        if (b) sell = Math.max(mid(b) * (1 - o.fillPct / 100), 0.01);
        sellPriced = "bars";
      }
      if (sell === null) {
        done("no_fill", "no book at the sale");
        continue;
      }
      signal.trade = {
        contract,
        right: side.side,
        strike: leg.quote.strike,
        expiry,
        delta: leg.delta,
        fallback: leg.fallback,
        sideSecond: side.second,
        toSide: side.second - a.second,
        stockIn: side.price,
        buyMinute: ct,
        buy: bought.buy,
        book: bought.book,
        spread: bought.spread,
        buyPriced: bought.priced,
        exitMinute,
        exitReason,
        sell,
        sellPriced,
        stockOut: lastBar(bars, exitMinute, 5)?.c ?? null,
        volume30: await volume30(contract),
      };
      done("traded");
    }
    // The alerts not traded, as a model trades them.
    if (!unit) continue;
    if (expiry === undefined)
      expiry = await expiryFor(data, cal, symbol, date, s).catch(() => null);
    if (!expiry) continue;
    const priorBars = prior.map((d) => data.bars(symbol, d));
    const vol = stockVol(priorBars) ?? minuteVol(priorBars);
    if (vol === null) continue;
    for (const sig of signals.slice(first)) {
      if (sig.trade) continue;
      const model = whatIf(sig, sides.get(sig) ?? null, bars, {
        expiry: sig.expiry ?? expiry,
        vol,
        unit,
        end,
        s,
      });
      if (!model) continue;
      sig.whatIf =
        (await bookWhatIf(data, sig, model, bars, { unit, end, s, o })) ??
        model;
      if (sig.outcome === "slow_cross")
        sig.slowBurst = slowBurstOf(
          sig,
          model,
          cal.nextSessions(date, 1)[0]!,
          s,
        );
    }
  }
  return { symbol, signals, ignored };
}

/** The stock's volatility from its minute closes, annualised; null under 100 moves (the daily closes' fallback). */
function minuteVol(days: readonly (readonly MinuteBar[])[]): number | null {
  const moves: number[] = [];
  for (const d of days)
    for (let i = 1; i < d.length; i++) {
      const a = d[i - 1]!.c;
      const b = d[i]!.c;
      if (a > 0 && b > 0) moves.push(Math.log(b / a));
    }
  if (moves.length < 100) return null;
  const mean = moves.reduce((x, y) => x + y, 0) / moves.length;
  const variance =
    moves.reduce((x, y) => x + (y - mean) ** 2, 0) / (moves.length - 1);
  const v = Math.sqrt(variance * 390 * 252);
  return v > 0 ? v : null;
}

/** The nearer side line's share the stock reached by `until` (session seconds), from the alert price. */
function reachOf(
  seconds: readonly [number, number][],
  until: number,
  price: number,
  unit: number,
  s: Pick<StrangleSettings, "confirmUnits">,
): number {
  const line = s.confirmUnits * unit;
  let most = 0;
  for (const [sec, p] of seconds) {
    if (sec > until) break;
    most = Math.max(most, Math.abs(p / price - 1) / line);
  }
  return Number(most.toFixed(3));
}

/**
 * The longest stretch of (from, until] with no price, from the last price
 * before it (or `from`) to the next one (or `until`); null under DATA_GAP_SECONDS.
 */
export function longestGap(
  seconds: readonly [number, number][],
  from: number,
  until: number,
): { from: number; to: number } | null {
  let last = from;
  let best = { from, to: from };
  for (const [sec] of seconds) {
    if (sec <= from) continue;
    if (sec > until) break;
    if (sec - last > best.to - best.from) best = { from: last, to: sec };
    last = sec;
  }
  if (until - last > best.to - best.from) best = { from: last, to: until };
  if (best.to - best.from < DATA_GAP_SECONDS) return null;
  return best;
}

/**
 * The what-if on the saved books: the leg the bot picks at the model's buy
 * second (the model's strike when the pick fails), bought as a trade is (the
 * 1-second book, else the minute book) and sold at the minute book's bid at
 * the give-back; null when a book is missing.
 */
/** Whether a slow side's burst would have passed toward the what-if's side, by the same rule as a side in time. */
function slowBurstOf(
  sig: VolumeSignal,
  model: VolumeWhatIf,
  nextSession: string,
  s: StrangleSettings,
): { passes: boolean; need: number } {
  let need = s.burstMin;
  if (sig.kind !== "shock" && model.expiry > nextSession) need = s.burstMinWeek;
  if (sig.kind === "shock") need = 0;
  const passes = burstAgrees(model.right, sig.burst, {
    burstFilter: true,
    burstMin: need,
  });
  return { passes, need };
}

async function bookWhatIf(
  data: VolumeBacktestData,
  sig: VolumeSignal,
  model: VolumeWhatIf,
  bars: readonly MinuteBar[],
  m: { unit: number; end: number; s: StrangleSettings; o: VolumeRunOptions },
): Promise<VolumeWhatIf | null> {
  if (!data.optionQuotes) return null;
  const { date } = sig;
  const second = model.sideSecond ?? sig.second;
  const cm = Math.floor(second / 60) - 1;
  const right = model.right === "C" ? "call" : "put";
  const { quotes, bars: optionBars } = await chainQuotes(
    data,
    sig.symbol,
    date,
    cm,
    model.right,
    model.stockIn,
    model.expiry,
    second + lag,
  );
  const volume30 = async (contract: string) =>
    (optionBars.get(contract) ?? [])
      .filter((b) => cm - 30 < b.m && b.m <= cm)
      .reduce((sum, b) => sum + b.v, 0);
  let leg: Awaited<ReturnType<typeof legAt>> | null = null;
  for (const delta of legDeltas(m.s, sig.kind === "shock")) {
    leg = await legAt(
      quotes,
      model.stockIn,
      right,
      date,
      daysBetween(date, model.expiry),
      delta,
      m.s,
      volume30,
      (c) => c,
    );
    if (leg.ok) break;
  }
  // The bot's leg; when its pick fails (thin, too cheap: DELL 2026-05-08), the model's strike on its book.
  let contract = model.contract;
  let strike = model.strike;
  if (leg?.ok) {
    contract = leg.quote.symbol;
    strike = leg.quote.strike;
  }
  const legBars = optionBars.get(contract) ?? [];
  const dayQuotes =
    (
      await data
        .optionQuotes(contract, date, date)
        .catch(() => new Map<string, QuoteMinute[]>())
    ).get(date) ?? [];
  // The 1-second book, else the minute book; never the bar model.
  const bought = await priceBuy(
    data,
    contract,
    date,
    second,
    dayQuotes,
    legBars,
    { ...m.o, strictQuotes: false },
  );
  if (!bought || bought.priced === "bars") return null;
  const ct = Math.floor(second / 60);
  const exit = walkExit(
    bars,
    legBars,
    ct,
    model.right,
    model.stockIn,
    m.unit,
    m.end,
    m.s,
  );
  const sale = bookAt(dayQuotes, exit.minute);
  const stockOut = lastBar(bars, exit.minute, 5)?.c;
  if (!sale || !stockOut) return null;
  return {
    ...model,
    priced: "book",
    contract,
    strike,
    buyMinute: ct,
    exitMinute: exit.minute,
    exitReason: exit.reason,
    stockOut,
    buy: bought.buy,
    sell: sale.bid,
    ret: sale.bid / bought.buy - 1,
  };
}

/** An alert not traded, as a model trades it; null when it cannot be modelled. */
function whatIf(
  sig: VolumeSignal,
  side: { second: number; side: Leg; price: number } | null,
  bars: readonly MinuteBar[],
  m: {
    expiry: string;
    vol: number;
    unit: number;
    end: number;
    s: StrangleSettings;
  },
): VolumeWhatIf | null {
  const second = side?.second ?? sig.second;
  const stockIn = side?.price ?? sig.price;
  if (stockIn === null || !(stockIn > 0)) return null;
  let right: Leg = sig.alert === "up" ? "C" : "P";
  if (side) right = side.side;
  const call = right === "C";
  const buyMinute = Math.floor(second / 60);
  if (buyMinute >= m.end) return null;
  const exit = walkExit(
    bars,
    [],
    buyMinute,
    right,
    stockIn,
    m.unit,
    m.end,
    m.s,
  );
  const stockOut = lastBar(bars, exit.minute, 5)?.c;
  if (!stockOut) return null;
  const years = yearsToExpiry(sig.date, buyMinute, m.expiry);
  const strike = strikeAt(stockIn, years, m.vol, call, m.s.delta);
  const buy = Number(
    bsPrice(stockIn, strike, years, m.vol, call)[0].toFixed(4),
  );
  if (!(buy > 0)) return null;
  const later = yearsToExpiry(sig.date, exit.minute, m.expiry);
  const sell = Number(
    bsPrice(stockOut, strike, later, m.vol, call)[0].toFixed(4),
  );
  return {
    priced: "model",
    contract: occSymbol(sig.symbol, m.expiry, right, strike),
    right,
    strike,
    expiry: m.expiry,
    sideSecond: side?.second ?? null,
    buyMinute,
    exitMinute: exit.minute,
    exitReason: exit.reason,
    stockIn,
    stockOut,
    buy,
    sell,
    iv: Number(m.vol.toFixed(4)),
    ret: sell / buy - 1,
  };
}

export { occSymbol };

// ---- the account ----

export interface VolumeMoney {
  start: number;
  sizePct: number; // of the morning's account, a trade
  feePerContract: number; // each way
  maxPerStock: number; // trades a stock a day, one at a time
  // The live bot's limits; off: none (the research's "flat" account).
  limits: boolean;
  maxTradesPerDay: number;
  maxOpen: number;
  dayLossPct: number;
}

export type VolumeRefusal =
  | "busy" // the stock's earlier trade was still open
  | "per_stock" // the stock's trades for the day were used
  | "max_trades"
  | "max_open"
  | "day_loss"
  | "too_small";

export interface VolumeAccountTrade {
  signal: VolumeSignal;
  status: "taken" | VolumeRefusal;
  qty: number;
  pnl: number; // dollars, after fees
  ret: number; // the trade's return after fees, a fraction
}

export interface VolumeAccount {
  start: number;
  end: number;
  maxDrawdownPct: number;
  trades: VolumeAccountTrade[]; // every traded signal, taken or refused
  taken: number;
  won: number;
  avgRet: number; // mean return a taken trade, a fraction
}

/** A trade's return after fees, a fraction (leg_seconds' "avg per trade"). */
export function tradeReturn(t: VolumeTrade, fee: number): number {
  return (t.sell * 100 - fee) / (t.buy * 100 + fee) - 1;
}

/**
 * The account over every stock's run (leg_twice.pick "flat", then
 * leg_daycap.account): a stock's trades of a day in alert order, each only
 * once the one before is sold, up to maxPerStock; then each day in buy order,
 * sized from the morning's account, with the live limits when on (the day's
 * closed loss, trades bought, trades open at the buy). The worst drop is on
 * closed trades, in sale order.
 */
export function volumeAccount(
  runs: readonly VolumeStockRun[],
  m: VolumeMoney,
): VolumeAccount {
  const byStockDay = new Map<string, VolumeSignal[]>();
  for (const r of runs)
    for (const sig of r.signals) {
      if (!sig.trade) continue;
      const key = `${sig.date}|${sig.symbol}`;
      let list = byStockDay.get(key);
      if (!list) byStockDay.set(key, (list = []));
      list.push(sig);
    }
  const out: VolumeAccountTrade[] = [];
  const kept: VolumeSignal[] = [];
  const refuse = (signal: VolumeSignal, status: VolumeRefusal) =>
    out.push({ signal, status, qty: 0, pnl: 0, ret: 0 });
  for (const list of byStockDay.values()) {
    let busyTo = -1;
    let n = 0;
    // In time order: a shock alert inside a minute comes before that minute's plan alert.
    for (const sig of list.sort((a, b) => a.second - b.second)) {
      const t = sig.trade!;
      if (t.buyMinute <= busyTo) {
        refuse(sig, "busy");
        continue;
      }
      if (n >= m.maxPerStock) {
        refuse(sig, "per_stock");
        continue;
      }
      kept.push(sig);
      busyTo = t.exitMinute;
      n++;
    }
  }
  const byDay = new Map<string, VolumeSignal[]>();
  for (const sig of kept) {
    let list = byDay.get(sig.date);
    if (!list) byDay.set(sig.date, (list = []));
    list.push(sig);
  }
  let equity = m.start;
  let peak = m.start;
  let drop = 0;
  for (const date of [...byDay.keys()].sort()) {
    const start = equity;
    const done: { exit: number; pnl: number }[] = [];
    const taken: VolumeAccountTrade[] = [];
    const day = byDay
      .get(date)!
      .sort(
        (a, b) =>
          a.trade!.buyMinute - b.trade!.buyMinute || a.minute - b.minute,
      );
    for (const sig of day) {
      const t = sig.trade!;
      if (m.limits) {
        const closed = done
          .filter((d) => d.exit < t.buyMinute)
          .reduce((sum, d) => sum + d.pnl, 0);
        if (closed <= (-m.dayLossPct / 100) * start) {
          refuse(sig, "day_loss");
          continue;
        }
        if (done.length >= m.maxTradesPerDay) {
          refuse(sig, "max_trades");
          continue;
        }
        if (done.filter((d) => d.exit >= t.buyMinute).length >= m.maxOpen) {
          refuse(sig, "max_open");
          continue;
        }
      }
      const qty = Math.floor(((m.sizePct / 100) * start) / (t.buy * 100));
      if (qty < 1) {
        refuse(sig, "too_small");
        continue;
      }
      const pnl = qty * (t.sell - t.buy) * 100 - m.feePerContract * 2 * qty;
      done.push({ exit: t.exitMinute, pnl });
      taken.push({
        signal: sig,
        status: "taken",
        qty,
        pnl,
        ret: tradeReturn(t, m.feePerContract),
      });
    }
    for (const x of [...taken].sort(
      (a, b) => a.signal.trade!.exitMinute - b.signal.trade!.exitMinute,
    )) {
      equity += x.pnl;
      peak = Math.max(peak, equity);
      drop = Math.max(drop, 1 - equity / peak);
    }
    out.push(...taken);
  }
  const all = out.filter((x) => x.status === "taken");
  return {
    start: m.start,
    end: equity,
    maxDrawdownPct: drop * 100,
    trades: out,
    taken: all.length,
    won: all.filter((x) => x.pnl > 0).length,
    avgRet: all.length
      ? all.reduce((sum, x) => sum + x.ret, 0) / all.length
      : 0,
  };
}
