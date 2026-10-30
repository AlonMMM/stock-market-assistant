import {
  defaultExitRules,
  nextAction,
  type BotPositionState,
  type ExitReason,
  type ExitRules,
} from "./exits.js";
import {
  advanceWatch,
  priorLevels,
  watchFor,
  type BreakWatch,
} from "./levels.js";
import {
  premarketBlocks,
  premarketRatio,
  reactionReport,
  reportDates,
  type EarningsReport,
} from "./news.js";
import { expiryWindow, pickContract } from "./picker.js";
import {
  exitRules,
  pickRules,
  signalParams,
  type BotSettings,
} from "./settings.js";
import {
  cSignal,
  cState,
  priorFrom,
  type MinuteBar,
  type Prior,
} from "./signal.js";
import type { OptionQuote } from "../options.js";

// The Main bot's backtest for the app's Backtest page (the user, 2026-10-30:
// "test bot on a period on stocks ... the results is total gain/loss, and a
// list of trades, each with a graph"). One stock over a range of sessions,
// through the live bot's own rules: the signal (signal.ts), the news filter
// (news.ts), the contract (picker.ts) and the exits (exits.ts, levels.ts),
// on one-minute bars. The account (size, limits, the overnight cap, fees) is
// applied after, over every stock at once (backtest-account.ts), so changing
// the money settings needs no new run.
//
// Fills follow the research simulator (sim.py, research/indi-v2): a decision
// on an option bar's close is filled on the contract's next bar at its middle
// (high + low) / 2, plus `fillPct` on a buy and less it on a sale. Alpaca has
// no historical option quotes, so this is the closest model. The contract's
// delta is Black-Scholes from the implied volatility of its last bar within
// 10 minutes, as sim.py picks it.
//
// Differences from the live bot, shown on the page: early entry (2.7) is read
// on the minute's close, not inside the minute; the bot's limits other than
// buys a day and open positions (the daily loss, the drawdown pause, the
// broker's safety stop) are not applied.

export interface BacktestCalendar {
  /** Session minutes of a day (390, 210 on an early close), or null when closed. */
  sessionLength(date: string): number | null;
  previousSessions(date: string, count: number): string[];
  nextSessions(date: string, count: number): string[];
}

/** One option contract of the chain on a past date. */
export interface ChainContract {
  symbol: string; // OCC
  expiry: string;
  strike: number;
}

/** What the backtest reads. Every call is for one stock's run. */
export interface BacktestData {
  /** The stock's (or SPY's) regular-session minutes of a day; empty when none. */
  bars(symbol: string, date: string): MinuteBar[];
  /** Pre-market volume (04:00–09:30) of a day, null when unknown. */
  premarket(symbol: string, date: string): number | null;
  /** The contracts of one side with an expiry in [from, to], expired ones too. */
  chain(
    symbol: string,
    right: "call" | "put",
    from: string,
    to: string,
  ): Promise<ChainContract[]>;
  /** One-minute bars of contracts on one session, by contract. */
  optionDay(
    contracts: string[],
    date: string,
  ): Promise<Map<string, MinuteBar[]>>;
  /** One contract's one-minute bars on each session from `from` to `to`, by date. */
  optionRange(
    contract: string,
    from: string,
    to: string,
  ): Promise<Map<string, MinuteBar[]>>;
  /** The earnings calendar's reports listed on a date; null when it could not be read. */
  earnings(date: string): Promise<EarningsReport[] | null>;
  /** The last session with final data: a carried trade's walk stops there. */
  lastSession: string;
}

export type StepKind = "buy" | "sell" | "carry";

/** One fill or overnight hold of a trade, as shares of the position bought. */
export interface SimStep {
  date: string;
  minute: number; // session minute, 09:30 New York = 0
  kind: StepKind;
  // buy: 1; sell: the share of the original position sold; carry: the share held.
  share: number;
  price: number; // the fill (a carry: the option's 15:50 close)
  reason: ExitReason | "entry" | "data-end";
}

export interface SimTrade {
  id: string; // symbol|date|n
  symbol: string;
  contract: string;
  right: "C" | "P";
  date: string; // the signal's session
  minute: number; // the signal minute
  t: number;
  rvol: number;
  d2: number | null;
  bonus: boolean; // entered on the D2 bonus
  pyramid: boolean; // the pyramid's add to the trade before it
  sizeShare: number; // of the bot's size: 1, or pyramidSharePct / 100
  stock: number; // the stock at the signal
  strike: number;
  expiry: string;
  delta: number;
  volume30: number;
  fallback: boolean; // the cheap fallback chose it
  steps: SimStep[];
  // The walk reached the last session with data before the last sale: what
  // is left is valued at the last option close (the last step, "data-end").
  open: boolean;
  watch: { name: string; level: number } | null; // the failed-break level, when watched
}

export type SkipReason =
  | "earnings"
  | "premarket"
  | "no_expiry"
  | "no_strikes"
  | "no_prices"
  | "too_cheap"
  | "illiquid"
  | "no_fill";

/** A signal the bot did not buy, and why. */
export interface SimSkip {
  symbol: string;
  date: string;
  minute: number;
  right: "C" | "P";
  reason: SkipReason;
  detail: string;
  pyramid: boolean;
}

export interface StockRun {
  symbol: string;
  sessions: number; // sessions looked at
  noData: number; // sessions without the stock's bars or its prior sessions
  trades: SimTrade[];
  skips: SimSkip[];
}

export interface RunOptions {
  fillPct: number; // e.g. 2: a buy pays the bar's middle + 2%, a sale gets it - 2%
  rate?: number; // the risk-free rate for the delta
}

export const defaultFillPct = 2;
const rate = 0.045;
const barMaxAge = 10; // minutes: the last bar a contract's price is read from
const fillWithin = 3; // minutes after the signal for the buy's bar
const priorDays = 20;

// ---- Black-Scholes, as store.py ----

const cdf = (x: number) => {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
};

function bs(
  s: number,
  k: number,
  t: number,
  v: number,
  r: number,
  call: boolean,
): [number, number] {
  const d1 = (Math.log(s / k) + (r + (v * v) / 2) * t) / (v * Math.sqrt(t));
  const d2 = d1 - v * Math.sqrt(t);
  if (call) return [s * cdf(d1) - k * Math.exp(-r * t) * cdf(d2), cdf(d1)];
  return [k * Math.exp(-r * t) * cdf(-d2) - s * cdf(-d1), cdf(d1) - 1];
}

/** |delta| from the implied volatility of a price; null outside the model's range. */
export function impliedDelta(
  price: number,
  spot: number,
  strike: number,
  years: number,
  call: boolean,
  r = rate,
): number | null {
  let lo = 0.01;
  let hi = 6;
  if (!(
    bs(spot, strike, years, lo, r, call)[0] < price &&
    price < bs(spot, strike, years, hi, r, call)[0]
  ))
    return null;
  let m = lo;
  for (let i = 0; i < 60; i++) {
    m = (lo + hi) / 2;
    if (bs(spot, strike, years, m, r, call)[0] < price) lo = m;
    else hi = m;
  }
  return Math.abs(bs(spot, strike, years, m, r, call)[1]);
}

/** Years from a session minute to 16:00 New York on the expiry day, at least 10 minutes. */
export function yearsToExpiry(
  date: string,
  minute: number,
  expiry: string,
): number {
  const days =
    (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) /
    86_400_000;
  const minutes = days * 1440 + 960 - (570 + minute);
  return Math.max(minutes, 10) / (365 * 1440);
}

// ---- small helpers ----

const mid = (b: MinuteBar) => (b.h + b.l) / 2;

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

/** The stock's last close at or before `minute`. */
function closeAt(bars: readonly MinuteBar[], minute: number): number | null {
  return lastBar(bars, minute)?.c ?? null;
}

const occOf = (
  symbol: string,
  expiry: string,
  right: "C" | "P",
  strike: number,
) =>
  `${symbol.replace(".", "")}${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}${right}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
export { occOf as occSymbol };

// ---- the contract ----

type Pick =
  | {
      ok: true;
      contract: ChainContract;
      price: number;
      delta: number;
      volume30: number;
      fallback: boolean;
    }
  | { ok: false; reason: SkipReason; detail: string };

/** The bot's contract for a signal, from the chain and its bars up to the signal minute. */
async function pick(
  data: BacktestData,
  symbol: string,
  date: string,
  minute: number,
  right: "C" | "P",
  spot: number,
  s: BotSettings,
): Promise<Pick> {
  const rules = pickRules(s, symbol);
  const side = right === "C" ? "call" : "put";
  const [from, to] = expiryWindow(date, rules);
  const chain = await data.chain(symbol, side, from, to);
  const expiry = chain.map((c) => c.expiry).sort()[0];
  if (!expiry)
    return {
      ok: false,
      reason: "no_expiry",
      detail: `no expiry ${from} to ${to}`,
    };
  const call = right === "C";
  const near = chain
    .filter((c) => c.expiry === expiry)
    .filter((c) =>
      call
        ? spot <= c.strike && c.strike <= spot * (1 + rules.otmScanMax)
        : spot * (1 - rules.otmScanMax) <= c.strike && c.strike <= spot,
    )
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
    .slice(0, rules.maxStrikes);
  if (!near.length) return { ok: false, reason: "no_strikes", detail: "" };
  const bars = await data.optionDay(
    near.map((c) => c.symbol),
    date,
  );
  const years = yearsToExpiry(date, minute, expiry);
  // Each strike as a quote at its last price, so the bot's own picker chooses.
  const quotes: OptionQuote[] = [];
  for (const c of near) {
    const b = lastBar(bars.get(c.symbol) ?? [], minute, barMaxAge);
    if (!b) continue;
    const delta = impliedDelta(b.c, spot, c.strike, years, call);
    if (delta === null) continue;
    quotes.push({
      symbol: c.symbol,
      underlying: symbol,
      expiry,
      right: side,
      strike: c.strike,
      bid: b.c,
      ask: b.c,
      delta: call ? delta : -delta,
    });
  }
  const picked = pickContract(quotes, spot, side, date, rules);
  if (!picked.ok) {
    let detail = "";
    if (picked.reason === "too_cheap" && picked.quote)
      detail = `${picked.quote.strike} at $${picked.quote.bid.toFixed(2)}, under $${rules.minPrice.toFixed(2)}`;
    return { ok: false, reason: picked.reason, detail };
  }
  const contract = near.find((c) => c.symbol === picked.quote.symbol)!;
  const volume30 = (bars.get(contract.symbol) ?? [])
    .filter((b) => minute - 30 < b.m && b.m <= minute)
    .reduce((sum, b) => sum + b.v, 0);
  if (volume30 < rules.minVolume30)
    return {
      ok: false,
      reason: "illiquid",
      detail: `${contract.strike}: ${volume30} contracts in 30 minutes, under ${rules.minVolume30}`,
    };
  return {
    ok: true,
    contract,
    price: picked.mid,
    delta: picked.delta,
    volume30,
    fallback: picked.fallback === "cheap",
  };
}

// ---- the walk: one contract from the signal to its last sale ----

interface WalkInput {
  symbol: string;
  date: string;
  minute: number; // the signal (or the pyramid's) minute
  right: "C" | "P";
  stock: number; // the stock at that minute
  contract: string;
  expiry: string;
  watch: BreakWatch | null; // the failed-break watch, entry day
  prior: Prior;
}

interface Walked {
  steps: SimStep[];
  open: boolean;
  noFill: boolean;
}

// What one position is worth to `nextAction`: shares of 1000 contracts, so its
// halves round as the live bot's do for a large position.
const nominal = 1000;

async function walk(
  data: BacktestData,
  cal: BacktestCalendar,
  w: WalkInput,
  s: BotSettings,
  o: RunOptions,
): Promise<Walked> {
  const fill = o.fillPct / 100;
  const base: ExitRules = exitRules(s);
  // The sessions it may be held: the entry day, then up to maxNights more, never past the expiry.
  const later = cal
    .nextSessions(w.date, Math.max(0, s.maxNights))
    .filter((d) => d <= w.expiry && d <= data.lastSession);
  const days = [w.date, ...later];
  const option = await data.optionRange(w.contract, w.date, days.at(-1)!);
  const steps: SimStep[] = [];
  let cost: number | null = null;
  let rem = 1; // share of the position still held
  let pending: { share: number | "all"; reason: ExitReason } | null = null;
  let state: BotPositionState = {
    right: w.right,
    qty: nominal,
    cost: 0,
    entryMinute: w.minute,
    entryStock: w.stock,
    nights: 0,
    checksDone: [],
    morningDone: false,
  };
  let watch = w.watch;
  let last: { date: string; bar: MinuteBar } | null = null;
  const sell = (
    date: string,
    minute: number,
    price: number,
    share: number,
    reason: ExitReason,
  ) => {
    const q = Math.min(rem, share);
    rem -= q;
    steps.push({
      date,
      minute,
      kind: "sell",
      share: q,
      price: Math.max(price * (1 - fill), 0.01),
      reason,
    });
    state = { ...state, qty: Math.round(rem * nominal) };
  };
  const done = (): Walked => ({ steps, open: false, noFill: false });
  for (let k = 0; k < days.length; k++) {
    const date = days[k]!;
    const length = cal.sessionLength(date) ?? 390;
    const rules: ExitRules = {
      ...base,
      eodMinute: Math.min(defaultExitRules.eodMinute, length - 10),
      expiryLastMinute: Math.min(
        defaultExitRules.expiryLastMinute,
        length - 30,
      ),
    };
    const stockBars = data.bars(w.symbol, date);
    const spyBars = k === 0 ? data.bars("SPY", date) : [];
    const prevBars =
      k === 0 ? [] : data.bars(w.symbol, cal.previousSessions(date, 1)[0]!);
    const first = stockBars[0];
    const open = first && first.m <= 5 ? first.o : null;
    const prevClose = prevBars.at(-1)?.c ?? null;
    const nextDay = cal.nextSessions(date, 1)[0]!;
    let today: MinuteBar | null = null;
    let carried = false;
    for (const b of option.get(date) ?? []) {
      if (k === 0 && b.m <= w.minute) continue;
      last = { date, bar: b };
      today = b;
      if (cost === null) {
        if (b.m > w.minute + fillWithin)
          return { steps: [], open: false, noFill: true };
        cost = mid(b) * (1 + fill);
        state = { ...state, cost };
        steps.push({
          date,
          minute: b.m,
          kind: "buy",
          share: 1,
          price: cost,
          reason: "entry",
        });
        continue;
      }
      // The failed break (entry day): all out on the bar after it failed.
      if (k === 0 && watch && watch.state === "watching" && s.sellFailedBreak) {
        watch = advanceWatch(watch, stockBars, b.m - 1, w.right);
        if (watch.state === "failed" && b.m < rules.eodMinute) {
          sell(date, b.m, mid(b), rem, "failed-break");
          return done();
        }
      }
      if (pending) {
        sell(
          date,
          b.m,
          mid(b),
          pending.share === "all" ? rem : pending.share,
          pending.reason,
        );
        pending = null;
        if (rem <= 1e-9) return done();
      }
      const strength =
        k === 0 && s.sellOnWeakness
          ? (cState(stockBars, spyBars, w.prior, b.m)?.t ?? null)
          : null;
      const decision = nextAction(
        state,
        {
          minute: b.m,
          stock: closeAt(stockBars, b.m),
          option: b.c,
          strength,
          isExpiryDay: date === w.expiry,
          sessionBeforeExpiry: nextDay <= w.expiry,
          open,
          prevClose,
        },
        rules,
      );
      state = { ...state, ...decision.update };
      if (decision.reason === "check-10" && decision.sell > 0)
        state = { ...state, halfSold: true };
      if (decision.reason === "carry") {
        steps.push({
          date,
          minute: b.m,
          kind: "carry",
          share: rem,
          price: b.c,
          reason: "carry",
        });
        carried = true;
        break;
      }
      if (decision.sell > 0 && decision.reason) {
        const all = decision.sell >= state.qty;
        pending = {
          share: all ? "all" : decision.sell / nominal,
          reason: decision.reason,
        };
      }
    }
    if (cost === null) return { steps: [], open: false, noFill: true };
    if (carried || !today) continue; // a day without a trade in the contract: on to the next
    // A sale decided on the day's last bar, or a day that ended held without
    // the 15:50 decision (no bar then): at the last bar's close, as the bot
    // sells everything not carried.
    const reason: ExitReason =
      pending?.reason ?? (date === w.expiry ? "expiry-day" : "close-1550");
    sell(date, today.m, today.c, rem, reason);
    return done();
  }
  if (cost === null) return { steps: [], open: false, noFill: true };
  // Held past the last session with data (or past the last bar seen): valued at the last close.
  if (rem > 1e-9 && last) {
    steps.push({
      date: last.date,
      minute: last.bar.m,
      kind: "sell",
      share: rem,
      price: last.bar.c,
      reason: "data-end",
    });
    // Open only when the data ran out; a contract that stopped trading before its expiry is closed at its last price.
    return {
      steps,
      open: days.at(-1) === data.lastSession && days.at(-1) !== w.expiry,
      noFill: false,
    };
  }
  return done();
}

// ---- one stock over a range ----

/** The bot's trades on one stock over `dates` (sessions, oldest first). */
export async function runStock(
  symbol: string,
  dates: readonly string[],
  s: BotSettings,
  data: BacktestData,
  cal: BacktestCalendar,
  o: RunOptions = { fillPct: defaultFillPct },
): Promise<StockRun> {
  const out: StockRun = {
    symbol,
    sessions: dates.length,
    noData: 0,
    trades: [],
    skips: [],
  };
  const params = signalParams(s);
  for (const date of dates) {
    const length = cal.sessionLength(date);
    if (length === null) continue;
    const day = data.bars(symbol, date);
    const spy = data.bars("SPY", date);
    const before = cal.previousSessions(date, priorDays);
    const priorSessions = before.map((d) => ({
      stock: data.bars(symbol, d),
      spy: data.bars("SPY", d),
    }));
    if (!day.length || !spy.length) {
      out.noData++;
      continue;
    }
    const prior = priorFrom(priorSessions);
    const sig = cSignal(
      day,
      spy,
      prior,
      Math.min(params.lastMinute, length - 16),
      params,
    );
    if (!sig) continue;
    const skip = (
      reason: SkipReason,
      detail: string,
      minute = sig.minute,
      pyramid = false,
    ) =>
      out.skips.push({
        symbol,
        date,
        minute,
        right: sig.right,
        reason,
        detail,
        pyramid,
      });
    // The news filter: no entry on an earnings reaction day or a busy pre-market.
    const news = await newsBlock(symbol, date, s, data, cal);
    if (news) {
      skip(news.reason, news.detail);
      continue;
    }
    const spot = closeAt(day, sig.minute);
    if (spot === null) continue;
    const picked = await pick(
      data,
      symbol,
      date,
      sig.minute,
      sig.right,
      spot,
      s,
    );
    if (!picked.ok) {
      skip(picked.reason, picked.detail);
      continue;
    }
    const levels = priorLevels(priorSessions.slice(-5).map((p) => p.stock));
    const watch = s.sellFailedBreak
      ? watchFor(levels, day, sig.minute, spot, sig.right)
      : null;
    const walked = await walk(
      data,
      cal,
      {
        symbol,
        date,
        minute: sig.minute,
        right: sig.right,
        stock: spot,
        contract: picked.contract.symbol,
        expiry: picked.contract.expiry,
        watch,
        prior,
      },
      s,
      o,
    );
    if (walked.noFill) {
      skip(
        "no_fill",
        `no ${picked.contract.strike} trade within ${fillWithin} minutes`,
      );
      continue;
    }
    const trade: SimTrade = {
      id: `${symbol}|${date}|0`,
      symbol,
      contract: picked.contract.symbol,
      right: sig.right,
      date,
      minute: sig.minute,
      t: sig.t,
      rvol: sig.rvol,
      d2: sig.d2,
      bonus: sig.bonus,
      pyramid: false,
      sizeShare: 1,
      stock: spot,
      strike: picked.contract.strike,
      expiry: picked.contract.expiry,
      delta: picked.delta,
      volume30: picked.volume30,
      fallback: picked.fallback,
      steps: walked.steps,
      open: walked.open,
      watch: watch ? { name: watch.name, level: watch.level } : null,
    };
    out.trades.push(trade);
    if (s.pyramid && sig.bonus) {
      const add = await pyramid(
        trade,
        day,
        spy,
        prior,
        length,
        s,
        data,
        cal,
        o,
      );
      if (add && "skip" in add) skip(add.skip, add.detail, add.minute, true);
      else if (add) out.trades.push(add);
    }
  }
  return out;
}

/**
 * The pyramid (2.7): after a D2 bonus entry, the first minute that day the
 * stock reaches the full signal on the same side, with the first position
 * held and its option above what it cost: one more position of
 * pyramidSharePct of the size in a fresh pick.
 */
async function pyramid(
  first: SimTrade,
  day: readonly MinuteBar[],
  spy: readonly MinuteBar[],
  prior: Prior,
  length: number,
  s: BotSettings,
  data: BacktestData,
  cal: BacktestCalendar,
  o: RunOptions,
): Promise<
  SimTrade | { skip: SkipReason; detail: string; minute: number } | null
> {
  const full = { ...signalParams(s), bonusT: null };
  const sig = cSignal(
    day,
    spy,
    prior,
    Math.min(full.lastMinute, length - 16),
    full,
  );
  if (!sig || sig.minute <= first.minute || sig.right !== first.right)
    return null;
  // Held at that minute: no sale of all of it on the entry day by then.
  const soldOut = first.steps
    .filter(
      (x) =>
        x.kind === "sell" && x.date === first.date && x.minute <= sig.minute,
    )
    .reduce((sum, x) => sum + x.share, 0);
  if (soldOut >= 1 - 1e-9) return null;
  const cost = first.steps[0]?.price ?? null;
  const bars = await data.optionDay([first.contract], first.date);
  const mark = lastBar(bars.get(first.contract) ?? [], sig.minute)?.c ?? null;
  if (cost === null || mark === null || mark <= cost) return null;
  const spot = closeAt(day, sig.minute);
  if (spot === null) return null;
  const picked = await pick(
    data,
    first.symbol,
    first.date,
    sig.minute,
    sig.right,
    spot,
    s,
  );
  if (!picked.ok)
    return { skip: picked.reason, detail: picked.detail, minute: sig.minute };
  const walked = await walk(
    data,
    cal,
    {
      symbol: first.symbol,
      date: first.date,
      minute: sig.minute,
      right: sig.right,
      stock: spot,
      contract: picked.contract.symbol,
      expiry: picked.contract.expiry,
      watch: null,
      prior,
    },
    s,
    o,
  );
  if (walked.noFill)
    return {
      skip: "no_fill",
      detail: `no ${picked.contract.strike} trade within ${fillWithin} minutes`,
      minute: sig.minute,
    };
  return {
    ...first,
    id: `${first.symbol}|${first.date}|1`,
    contract: picked.contract.symbol,
    minute: sig.minute,
    t: sig.t,
    rvol: sig.rvol,
    d2: sig.d2,
    bonus: false,
    pyramid: true,
    sizeShare: s.pyramidSharePct / 100,
    stock: spot,
    strike: picked.contract.strike,
    expiry: picked.contract.expiry,
    delta: picked.delta,
    volume30: picked.volume30,
    fallback: picked.fallback,
    steps: walked.steps,
    open: walked.open,
    watch: null,
  };
}

/** The news filter's reason to skip a stock's signal on a day, or null. */
async function newsBlock(
  symbol: string,
  date: string,
  s: BotSettings,
  data: BacktestData,
  cal: BacktestCalendar,
): Promise<{ reason: SkipReason; detail: string } | null> {
  if (s.skipPremarket) {
    const before = cal.previousSessions(date, 20);
    const ratio = premarketRatio(
      data.premarket(symbol, date),
      before.map((d) => data.premarket(symbol, d)),
    );
    if (premarketBlocks(ratio))
      return {
        reason: "premarket",
        detail: `pre-market volume ${ratio!.toFixed(1)}× normal`,
      };
  }
  if (s.skipEarnings) {
    const prev = cal.previousSessions(date, 1)[0]!;
    const reports: EarningsReport[] = [];
    for (const d of reportDates(date, prev)) {
      const got = await data.earnings(d);
      if (got) reports.push(...got.filter((r) => r.symbol === symbol));
    }
    const gap = (d: string) => {
      const today = data.bars(symbol, d)[0];
      const before = data.bars(symbol, cal.previousSessions(d, 1)[0]!).at(-1);
      return today && before ? Math.abs(today.o / before.c - 1) : null;
    };
    const hit = reactionReport(
      reports,
      date,
      {
        isSession: (d) => cal.sessionLength(d) !== null,
        nextSession: (d) => cal.nextSessions(d, 1)[0]!,
      },
      gap,
    );
    if (hit)
      return {
        reason: "earnings",
        detail: `earnings reaction day (report listed ${hit.date})`,
      };
  }
  return null;
}

/** The sessions a request covers, plus what the stock's bars must include around them. */
export function dataWindow(
  dates: readonly string[],
  cal: BacktestCalendar,
  lastSession: string,
  maxNights: number,
): { from: string; to: string } {
  const from = cal.previousSessions(dates[0]!, priorDays + 1)[0]!;
  const after = cal
    .nextSessions(dates.at(-1)!, Math.max(0, maxNights))
    .filter((d) => d <= lastSession);
  return { from, to: after.at(-1) ?? dates.at(-1)! };
}
