// The end-of-day review (the user, 2026-11-05: "run backtest (app) and
// compare the trade in enter time, enter and exit, enter and exit money ...
// summarize if the bot was too optimistic or too pessimistic, and save it all
// with analysis under an Analyse tab in the bot window"). Each evening, for
// each bot, the app's backtest of the day runs as the Backtest page's "Same as
// paper" run (the live settings and stocks) on the server's job queue; then
// every live trade of the day is set beside the backtest's, trade by trade,
// and the result is kept in D1. The written analysis (the end-of-day skill,
// a scheduled Claude run) is saved on the same row.
//
// Prices: the live side has its paper fills and the "real" price, the mid of
// the book recorded at the fill (else at the decision): the accounts are
// paper accounts, so the real price is the verdict (the user, 2026-11-05).
// The backtest of the day reads the books the trading service recorded during
// the session (source "recorded", below) where Databento's are not uploaded
// yet (the user, 2026-11-05: "we are saving the data of the options").
import { coreClose, newYorkToUtc } from "./calendar.js";
import type { D1Like } from "./bar-cache.js";
import type {
  AccountResult,
  MoneySettings,
} from "../../trading/src/bot/backtest-account.js";
import { defaultMoney } from "../../trading/src/bot/backtest-account.js";
import type { SimSkip, SimTrade } from "../../trading/src/bot/backtest.js";
import type { BotSettings } from "../../trading/src/bot/settings.js";
import { withDefaults } from "../../trading/src/bot/settings.js";
import {
  currentVersion,
  ruleKeys,
  versionById,
  type Rules,
} from "../../trading/src/bot/versions.js";
import type {
  VolumeAccount,
  VolumeMoney,
  VolumeSignal,
} from "../../trading/src/strangle/backtest.js";
import type { StrangleSettings } from "../../trading/src/strangle/settings.js";
import {
  strangleStocks,
  strangleWithDefaults,
} from "../../trading/src/strangle/settings.js";

export type ReviewBot = "main" | "volume";
export const reviewBots: readonly ReviewBot[] = ["main", "volume"];

// The jobs' owner: never a viewer's email, so the runs stay off the Backtest
// page's list and do not push out the owner's own kept runs.
export const reviewOwner = "system:day-review";
// The fee each way a contract, as the backtest charges (backtest-cost-model).
export const reviewFee = defaultMoney.feePerContract;
// A book recorded live is used where Databento's minute is missing.
export const recordedSource = "recorded";
// Matched trades whose results differ by less than this many points of the
// money paid are "on target".
export const onTargetPts = 5;
// At most this many stocks a run, as the Backtest page.
const maxStocks = 100;

// ---- the live records (the trader's GET /v1/bot/day and /v1/strangle/day) ----

export interface Book {
  bid: number;
  ask: number;
  at?: number;
}

/** A Main bot position as the trader keeps it (bot-store.ts BotPosition), the fields used here. */
export interface LivePosition {
  id: string;
  day: string;
  symbol: string;
  contract: string;
  right: "C" | "P";
  qty: number;
  bought: number;
  cost: number;
  entryMinute: number;
  openedAt: number;
  filledAt?: number;
  closedAt: number | null;
  status: "buying" | "open" | "closed";
  dry: boolean;
  broker?: string;
  version?: string;
  bonus?: boolean;
  addOf?: string;
  entryBook?: Book;
  entryFillBook?: Book;
  sales: {
    at: number;
    qty: number;
    reason: string;
    settled?: boolean;
    price?: number;
    book?: Book;
    fillBook?: Book;
  }[];
}

export interface LiveSignal {
  day: string;
  symbol: string;
  right: "C" | "P";
  minute: number;
  outcome: string;
  detail: string;
  t?: number;
  rvol?: number;
  volume30?: number;
  version?: string;
  // Each account's pick (bot-store.ts BotLeg): the contract, its delta and
  // 30-minute volume as the broker gave them, and what came of it.
  legs?: {
    broker: string;
    outcome: string;
    detail: string;
    contract?: string;
    delta?: number;
    volume30?: number;
    volumeSource?: string;
  }[];
}

export interface MainDay {
  day: string;
  version: string;
  settings: Partial<BotSettings>;
  watching: string[];
  signals: LiveSignal[];
  positions: LivePosition[];
}

/** A Volume bot trade as the trader keeps it (strangle-store.ts StrangleTrade), the fields used here. */
export interface LiveVolumeTrade {
  id: string;
  day: string;
  symbol: string;
  alertMinute: number;
  alertSecond?: number;
  side: "C" | "P" | null;
  shock?: boolean;
  phase: string;
  closeReason?: string | null;
  dry: boolean;
  version?: string;
  openedAt: number;
  closedAt: number | null;
  leg: {
    contract: string;
    qty: number;
    bought: number;
    cost: number;
    orders: {
      at: number;
      side: "buy" | "sell";
      qty: number;
      reason: string;
      settled: boolean;
      price?: number;
      book?: Book;
      fillBook?: Book;
    }[];
  } | null;
}

export interface VolumeAlertRow {
  day: string;
  symbol: string;
  minute: number;
  side: "up" | "down";
  outcome: string;
  detail: string;
}

export interface VolumeDay {
  day: string;
  settings: Partial<StrangleSettings>;
  watching: string[];
  signals: VolumeAlertRow[];
  trades: LiveVolumeTrade[];
}

// ---- the backtest of the day ----

/** The Main bot's job, as the Backtest page's "Same as paper" run of one day. */
export function mainJob(live: MainDay, date: string) {
  const settings = withDefaults(live.settings);
  const off = new Set(settings.off.map((t) => t.toUpperCase()));
  const rules = Object.fromEntries(
    ruleKeys.map((k) => [k, settings[k]]),
  ) as Rules;
  const tickers = [...new Set(live.watching.map((t) => t.toUpperCase()))]
    .filter((t) => !off.has(t))
    .slice(0, maxStocks);
  const money: MoneySettings = {
    ...defaultMoney,
    sizePct: settings.sizePct,
    sizeSteps: settings.sizeSteps ?? [],
    maxBuysPerDay: settings.maxBuysPerDay,
    maxOpen: settings.maxOpen,
    nightCapPct: settings.nightCapPct,
  };
  return {
    spec: {
      bot: "main" as const,
      parts: tickers.map((symbol) => ({ symbol, from: date, to: date })),
      body: {
        rules,
        fillPct: defaultMoney.fillPct,
        quoteSources: ["databento", recordedSource],
      },
      meta: {
        review: date,
        version: versionById(settings.version)?.id ?? currentVersion,
      },
    },
    money,
  };
}

/** The Volume bot's job, as the Backtest page's "Same as paper" run of one day. */
export function volumeJob(live: VolumeDay, date: string) {
  const settings = strangleWithDefaults(live.settings);
  const tickers = (
    live.watching.length ? live.watching : strangleStocks(settings, [])
  ).slice(0, maxStocks);
  const money: VolumeMoney = {
    start: 100_000,
    sizePct: settings.sizePct,
    feePerContract: reviewFee,
    maxPerStock: settings.maxPerStock,
    limits: true,
    maxTradesPerDay: settings.maxTradesPerDay,
    maxOpen: settings.maxOpen,
    dayLossPct: settings.dayLossPct,
  };
  return {
    spec: {
      bot: "volume" as const,
      parts: tickers.map((symbol) => ({ symbol, from: date, to: date })),
      body: {
        settings,
        fillPct: defaultMoney.fillPct,
        quoteSources: ["databento", recordedSource],
      },
      meta: { review: date },
    },
    money,
  };
}

/**
 * Recorded books as minute books (option_quotes rows): a sample read during
 * session minute m is known as m closes, so the newest one of each minute is
 * that minute's book. Never a later sample: no look-ahead.
 */
export function minuteBooks(
  date: string,
  samples: readonly { at: number; bid: number | null; ask: number | null }[],
): [number, number, number][] {
  const openMs = newYorkToUtc(date, 570);
  const byMinute = new Map<
    number,
    { at: number; row: [number, number, number] }
  >();
  for (const s of samples) {
    if (s.bid === null || s.ask === null || !(s.ask > 0) || s.bid < 0) continue;
    if (s.bid > s.ask) continue;
    const m = Math.floor((s.at - openMs) / 60000);
    if (m < 0 || m >= 390) continue;
    const kept = byMinute.get(m);
    if (!kept || s.at >= kept.at)
      byMinute.set(m, { at: s.at, row: [m, s.bid, s.ask] });
  }
  return [...byMinute.values()].map((v) => v.row).sort((a, b) => a[0] - b[0]);
}

// ---- the comparison ----

export interface LiveSide {
  ref: string;
  contract: string;
  broker: string | null;
  dry: boolean;
  version: string | null;
  entryAt: number;
  qty: number;
  paidPaper: number; // the average buy fill, a share
  paidReal: number | null; // the recorded book's mid at the buy
  exits: {
    at: number;
    qty: number;
    paper: number;
    real: number | null;
    reason: string;
  }[];
  open: boolean;
  retPaper: number | null; // % after fees, closed only
  retReal: number | null;
  pnlPaper: number | null; // dollars after fees
  pnlReal: number | null;
}

export interface BacktestSide {
  contract: string;
  entryAt: number;
  entryPrice: number;
  exits: { at: number; share: number; price: number; reason: string }[];
  open: boolean;
  ret: number | null; // % after fees, closed only
  priced: string; // "quotes" | "trades" (Main), "seconds" | ... (Volume)
  account: string; // the account's verdict: taken, or why refused
  // The contract's pick: its |delta| (the backtest's own, from the option's
  // price) and 30-minute volume, for the causes of a difference.
  delta: number | null;
  volume30: number | null;
  // What the backtest's own account paid ($, on its $100,000 start at the
  // bot's size): sizes a trade the bot did not take on a day it took none.
  simPaid: number | null;
}

/** One account's day, for the bot-against-backtest chart (Analyse page). */
export interface AccountDay {
  broker: string; // "alpaca" | "ibkr"
  bot: number; // $ at market, the bot's closed trades of the day, after fees
  botPaper: number; // $ at the paper fills
  // $, each backtest trade at the bot's size: the cost of the bot's own trade
  // when it took the same one, else the bot's average cost a trade that day
  // (else the backtest account's own cost).
  backtest: number;
  botTrades: number;
  backtestTrades: number;
}

export interface ReviewRow {
  key: string;
  symbol: string;
  right: "C" | "P" | null;
  kind: string; // Main: entry, d2, pyramid. Volume: plan, shock
  match: "both" | "live-only" | "backtest-only";
  why: string | null; // a one-sided row: why the other side has none
  live: LiveSide | null;
  backtest: BacktestSide | null;
  // Both sides, closed: backtest minus live.
  entryMinutes: number | null;
  entryPct: number | null; // backtest's buy vs live real, %
  exitPct: number | null; // backtest's average sale vs live real, %
  retGapPts: number | null; // backtest ret − live real ret
  dollarsGap: number | null; // the backtest's ret at the live cost − live real $
}

export type Verdict = "optimistic" | "pessimistic" | "on target" | "no trades";

export interface ReviewSummary {
  liveTrades: number;
  backtestTrades: number;
  matched: number;
  liveOnly: number;
  backtestOnly: number;
  open: number; // held overnight on either side: judged on a later day
  livePaper: number; // $ after fees, closed live trades
  liveReal: number;
  backtestAtLiveSize: number; // $, the closed matched trades at the live cost
  liveRealMatched: number;
  gapDollars: number; // backtestAtLiveSize − liveRealMatched
  gapPts: number; // gapDollars over the matched trades' live cost, %
  verdict: Verdict;
  estimates: number; // backtest trades priced on trade bars, not books
}

export interface Comparison {
  bot: ReviewBot;
  date: string;
  version: string | null;
  stocks: number;
  rows: ReviewRow[];
  summary: ReviewSummary;
  // Each account the bot trades at: its day against the backtest's.
  accounts: AccountDay[];
  notes: string[];
  // The records the causes are looked for in (the end-of-day skill's
  // "find the cause" step): each side's view of the day's signals.
  evidence: {
    // Main: the live signals with each account's pick; Volume: the alerts.
    live: unknown[];
    // Main: the backtest's skips (no contract, illiquid, too cheap, news);
    // Volume: the backtest's alerts that did not trade, with why.
    backtest: unknown[];
    // The bot's saved settings at review time (what both sides ran).
    settings: unknown;
  };
}

const mid = (b: Book | undefined): number | null =>
  b && b.ask > 0 && b.bid >= 0 && b.bid <= b.ask ? (b.bid + b.ask) / 2 : null;

/** A trade's return after fees, %: paid and got per share, qty contracts. */
function retAfterFees(paid: number, got: number, qty: number): number {
  const cost = paid * 100 * qty + reviewFee * qty;
  const back = got * 100 * qty - reviewFee * qty;
  return cost > 0 ? (back / cost - 1) * 100 : 0;
}

function pnlAfterFees(paid: number, got: number, qty: number): number {
  return (got - paid) * 100 * qty - 2 * reviewFee * qty;
}

/** The live side from its buy and its sales. */
function liveSide(o: {
  ref: string;
  contract: string;
  broker: string | null;
  dry: boolean;
  version: string | null;
  entryAt: number;
  qty: number;
  paidPaper: number;
  paidReal: number | null;
  exits: LiveSide["exits"];
  open: boolean;
}): LiveSide {
  const sold = o.exits.reduce((s, e) => s + e.qty, 0);
  const closed = !o.open && o.qty > 0 && sold >= o.qty;
  const avg = (pick: (e: LiveSide["exits"][number]) => number | null) => {
    let sum = 0;
    for (const e of o.exits) {
      const p = pick(e);
      if (p === null) return null;
      sum += p * e.qty;
    }
    return sold ? sum / sold : null;
  };
  const gotPaper = avg((e) => e.paper);
  const gotReal = avg((e) => e.real);
  const realBuy = o.paidReal;
  return {
    ...o,
    open: !closed,
    retPaper:
      closed && gotPaper !== null
        ? retAfterFees(o.paidPaper, gotPaper, o.qty)
        : null,
    retReal:
      closed && gotReal !== null && realBuy !== null
        ? retAfterFees(realBuy, gotReal, o.qty)
        : null,
    pnlPaper:
      closed && gotPaper !== null
        ? pnlAfterFees(o.paidPaper, gotPaper, o.qty)
        : null,
    pnlReal:
      closed && gotReal !== null && realBuy !== null
        ? pnlAfterFees(realBuy, gotReal, o.qty)
        : null,
  };
}

/** The live Main bot's positions of the day: real ones, else the dry run's. */
function mainLive(live: MainDay): LiveSide[] {
  const day = live.positions.filter((p) => p.day === live.day && p.bought > 0);
  const real = day.filter((p) => !p.dry);
  return (real.length ? real : day).map((p) =>
    liveSide({
      ref: p.id,
      contract: p.contract,
      broker: p.broker ?? null,
      dry: p.dry,
      version: p.version ?? null,
      entryAt: p.filledAt ?? p.openedAt,
      qty: p.bought,
      paidPaper: p.cost,
      paidReal: mid(p.entryFillBook ?? p.entryBook),
      exits: p.sales
        .filter((s) => s.price !== undefined && s.settled !== false)
        .map((s) => ({
          at: s.at,
          qty: s.qty,
          paper: s.price!,
          real: mid(s.fillBook ?? s.book),
          reason: s.reason,
        })),
      open: p.status !== "closed",
    }),
  );
}

function mainKind(t: { bonus?: boolean; pyramid?: boolean; addOf?: string }) {
  if (t.pyramid || t.addOf) return "pyramid";
  if (t.bonus) return "d2";
  return "entry";
}

/** The backtest side of a Main bot trade, through the account. */
function mainBacktest(t: SimTrade, status: string): BacktestSide {
  const at = (date: string, minute: number) =>
    newYorkToUtc(date, 570 + minute + 1);
  const buy = t.steps.find((s) => s.kind === "buy");
  const sells = t.steps.filter((s) => s.kind === "sell");
  const carried = t.steps.some((s) => s.kind === "carry");
  const dataEnd = sells.some((s) => s.reason === "data-end");
  const open = t.open || dataEnd || (carried && !sells.length);
  const share = sells.reduce((s, x) => s + x.share, 0);
  const got = share
    ? sells.reduce((s, x) => s + x.price * x.share, 0) / share
    : 0;
  const entryPrice = buy?.price ?? 0;
  return {
    contract: t.contract,
    entryAt: buy ? at(buy.date, buy.minute) : at(t.date, t.minute),
    entryPrice,
    exits: sells.map((s) => ({
      at: at(s.date, s.minute),
      share: s.share,
      price: s.price,
      reason: s.reason,
    })),
    open,
    ret: !open && entryPrice > 0 ? retAfterFees(entryPrice, got, 1) : null,
    priced: t.priced,
    account: status,
    delta: t.delta ?? null,
    volume30: t.volume30 ?? null,
    simPaid: null,
  };
}

/** The gaps of a matched pair, both closed (else only the entry). */
function gaps(live: LiveSide, bt: BacktestSide) {
  const entryMinutes = Math.round((live.entryAt - bt.entryAt) / 60000);
  const realBuy = live.paidReal ?? live.paidPaper;
  const entryPct = realBuy > 0 ? (bt.entryPrice / realBuy - 1) * 100 : null;
  if (live.open || bt.open || bt.ret === null || live.retReal === null)
    return {
      entryMinutes,
      entryPct,
      exitPct: null,
      retGapPts: null,
      dollarsGap: null,
    };
  const sold = live.exits.reduce((s, e) => s + e.qty, 0);
  const liveGot = sold
    ? live.exits.reduce((s, e) => s + (e.real ?? e.paper) * e.qty, 0) / sold
    : 0;
  const share = bt.exits.reduce((s, x) => s + x.share, 0);
  const btGot = share
    ? bt.exits.reduce((s, x) => s + x.price * x.share, 0) / share
    : 0;
  const cost = realBuy * 100 * live.qty + reviewFee * live.qty;
  return {
    entryMinutes,
    entryPct,
    exitPct: liveGot > 0 ? (btGot / liveGot - 1) * 100 : null,
    retGapPts: bt.ret - live.retReal,
    dollarsGap: (cost * bt.ret) / 100 - live.pnlReal!,
  };
}

/**
 * Pairs each live trade with the backtest trade of the same stock, side and
 * kind nearest in time (within `window` ms); one backtest trade may pair with
 * a live trade on each broker.
 */
function pairUp<
  L extends {
    symbol: string;
    right: string | null;
    kind: string;
    at: number;
    broker: string | null;
  },
  B extends { symbol: string; right: string | null; kind: string; at: number },
>(
  live: L[],
  bt: B[],
  window: number,
): { pairs: [L, B][]; liveOnly: L[]; btOnly: B[] } {
  const pairs: [L, B][] = [];
  const liveOnly: L[] = [];
  const usedBy = new Map<B, Set<string>>();
  for (const l of [...live].sort((a, b) => a.at - b.at)) {
    let best: B | null = null;
    for (const b of bt) {
      if (b.symbol !== l.symbol || b.right !== l.right) continue;
      // A pyramid add pairs only with an add; a first entry pairs with a
      // first entry whatever each side called it (live's plain entry was the
      // backtest's D2 entry on GOOGL 2026-11-04).
      if ((b.kind === "pyramid") !== (l.kind === "pyramid")) continue;
      if (Math.abs(b.at - l.at) > window) continue;
      if (usedBy.get(b)?.has(l.broker ?? "")) continue;
      if (!best || Math.abs(b.at - l.at) < Math.abs(best.at - l.at)) best = b;
    }
    if (!best) {
      liveOnly.push(l);
      continue;
    }
    let used = usedBy.get(best);
    if (!used) usedBy.set(best, (used = new Set()));
    used.add(l.broker ?? "");
    pairs.push([l, best]);
  }
  return { pairs, liveOnly, btOnly: bt.filter((b) => !usedBy.has(b)) };
}

const liveCost = (l: LiveSide) =>
  (l.paidReal ?? l.paidPaper) * 100 * l.qty + reviewFee * l.qty;

/** Each account's day: the bot's closed trades, and every backtest trade at that account's size. */
function accountsOf(
  brokers: readonly string[],
  rows: readonly ReviewRow[],
  backtest: readonly BacktestSide[],
): AccountDay[] {
  // The accounts the bot traded at that day; on a day without a trade, the
  // first one it buys at (never an account that did not trade, sized from the
  // backtest's own $100,000: a loss nobody could have had).
  const seen = rows.flatMap((r) =>
    r.live ? [r.live.broker ?? brokers[0]!] : [],
  );
  const traded = seen.length ? [...new Set(seen)] : [brokers[0]!];
  return traded.map((broker) => {
    const own = rows.filter(
      (r) => r.live && (r.live.broker ?? brokers[0]) === broker,
    );
    const closed = own.filter((r) => !r.live!.open);
    const costs = own.map((r) => liveCost(r.live!));
    const average = costs.length
      ? costs.reduce((a, b) => a + b, 0) / costs.length
      : null;
    let total = 0;
    let counted = 0;
    for (const b of backtest) {
      if (b.open || b.ret === null) continue;
      const pair = own.find((r) => r.backtest === b);
      let cost = average ?? b.simPaid;
      if (pair) cost = liveCost(pair.live!);
      if (cost === null) continue;
      total += (cost * b.ret) / 100;
      counted++;
    }
    return {
      broker,
      bot: closed.reduce((a, r) => a + (r.live!.pnlReal ?? 0), 0),
      botPaper: closed.reduce((a, r) => a + (r.live!.pnlPaper ?? 0), 0),
      backtest: total,
      botTrades: own.length,
      backtestTrades: counted,
    };
  });
}

function summarize(rows: ReviewRow[]): ReviewSummary {
  const liveRows = rows.filter((r) => r.live);
  const btRows = rows.filter((r) => r.backtest);
  const closedLive = liveRows.filter((r) => !r.live!.open);
  const matched = rows.filter((r) => r.match === "both");
  const judged = matched.filter((r) => r.dollarsGap !== null);
  const sum = (xs: (number | null)[]) =>
    xs.reduce<number>((s, x) => s + (x ?? 0), 0);
  const liveRealMatched = sum(judged.map((r) => r.live!.pnlReal));
  const gapDollars = sum(judged.map((r) => r.dollarsGap));
  const cost = judged.reduce(
    (s, r) =>
      s +
      (r.live!.paidReal ?? r.live!.paidPaper) * 100 * r.live!.qty +
      reviewFee * r.live!.qty,
    0,
  );
  const gapPts = cost > 0 ? (gapDollars / cost) * 100 : 0;
  let verdict: Verdict = "on target";
  if (!judged.length) verdict = "no trades";
  else if (gapPts > onTargetPts) verdict = "optimistic";
  else if (gapPts < -onTargetPts) verdict = "pessimistic";
  return {
    liveTrades: liveRows.length,
    backtestTrades: btRows.length,
    matched: matched.length,
    liveOnly: rows.filter((r) => r.match === "live-only").length,
    backtestOnly: rows.filter((r) => r.match === "backtest-only").length,
    open: rows.filter((r) => r.live?.open || r.backtest?.open).length,
    livePaper: sum(closedLive.map((r) => r.live!.pnlPaper)),
    liveReal: sum(closedLive.map((r) => r.live!.pnlReal)),
    backtestAtLiveSize: liveRealMatched + gapDollars,
    liveRealMatched,
    gapDollars,
    gapPts,
    verdict,
    estimates: btRows.filter(
      (r) => r.backtest!.priced === "trades" || r.backtest!.priced === "bars",
    ).length,
  };
}

// A live trade and its backtest twin are the same trade within this time.
const mainWindow = 30 * 60000;
const volumeWindow = 15 * 60000;

/** The Main bot's day: live positions against the backtest's account trades. */
export function compareMain(
  live: MainDay,
  account: AccountResult,
  skips: readonly SimSkip[],
  stocks: number,
): Comparison {
  const date = live.day;
  const positions = new Map(live.positions.map((p) => [p.id, p]));
  const liveRows = mainLive(live).map((side) => {
    const p = positions.get(side.ref)!;
    return {
      side,
      symbol: p.symbol,
      right: p.right,
      kind: mainKind(p),
      at: newYorkToUtc(date, 570 + p.entryMinute + 1),
      broker: side.broker,
    };
  });
  const btRows = account.trades
    .filter((a) => a.trade.date === date && a.status === "taken")
    .map((a) => ({
      a,
      side: { ...mainBacktest(a.trade, a.status), simPaid: a.paid },
      symbol: a.trade.symbol,
      right: a.trade.right,
      kind: mainKind(a.trade),
      at: newYorkToUtc(date, 570 + a.trade.minute + 1),
    }));
  const refused = account.trades.filter(
    (a) => a.trade.date === date && a.status !== "taken",
  );
  const { pairs, liveOnly, btOnly } = pairUp(liveRows, btRows, mainWindow);
  const signalOf = (symbol: string) =>
    live.signals.find((s) => s.symbol === symbol);
  const rows: ReviewRow[] = [
    ...pairs.map(([l, b]) => ({
      key: `${l.symbol}|${l.side.ref}`,
      symbol: l.symbol,
      right: l.right,
      kind: l.kind,
      match: "both" as const,
      why: null,
      live: l.side,
      backtest: b.side,
      ...gaps(l.side, b.side),
    })),
    ...liveOnly.map((l) => {
      const skip = skips.find(
        (s) => s.symbol === l.symbol && s.date === date && s.right === l.right,
      );
      const cut = refused.find(
        (a) => a.trade.symbol === l.symbol && a.trade.right === l.right,
      );
      let why = "no signal in the backtest";
      if (skip) why = `backtest skipped: ${skip.reason} ${skip.detail}`.trim();
      else if (cut) why = `backtest account refused: ${cut.status}`;
      return oneSided(
        l.symbol,
        l.side.ref,
        l.right,
        l.kind,
        "live-only",
        why,
        l.side,
        null,
      );
    }),
    ...btOnly.map((b) => {
      const sig = signalOf(b.symbol);
      const why = sig
        ? `live: ${sig.outcome}${sig.detail ? ` (${sig.detail})` : ""}`
        : "live: no signal";
      return oneSided(
        b.symbol,
        b.a.trade.id,
        b.right,
        b.kind,
        "backtest-only",
        why,
        null,
        b.side,
      );
    }),
  ];
  const notes: string[] = [];
  if (live.positions.some((p) => p.day === date && p.dry))
    notes.push("Some live positions are a dry run (no orders).");
  return {
    bot: "main",
    date,
    version: live.version ?? null,
    stocks,
    rows: sortRows(rows),
    summary: summarize(rows),
    accounts: accountsOf(
      mainBrokers(live.settings.broker),
      rows,
      btRows.map((b) => b.side),
    ),
    notes,
    evidence: {
      live: live.signals.filter((s) => s.day === date),
      backtest: skips
        .filter((k) => k.date === date)
        .map((k) => ({
          symbol: k.symbol,
          right: k.right,
          minute: k.minute,
          reason: k.reason,
          detail: k.detail,
          pyramid: k.pyramid,
          contract: k.contract,
        })),
      settings: live.settings,
    },
  };
}

/** The accounts the Main bot buys at: one, or both (settings.ts BotBrokerChoice). */
function mainBrokers(choice: string | undefined): string[] {
  if (choice === "both") return ["alpaca", "ibkr"];
  return [choice ?? "alpaca"];
}

function oneSided(
  symbol: string,
  ref: string,
  right: "C" | "P" | null,
  kind: string,
  match: "live-only" | "backtest-only",
  why: string,
  live: LiveSide | null,
  backtest: BacktestSide | null,
): ReviewRow {
  return {
    key: `${symbol}|${ref}`,
    symbol,
    right,
    kind,
    match,
    why,
    live,
    backtest,
    entryMinutes: null,
    entryPct: null,
    exitPct: null,
    retGapPts: null,
    dollarsGap: null,
  };
}

const rowAt = (r: ReviewRow) => r.live?.entryAt ?? r.backtest?.entryAt ?? 0;
const sortRows = (rows: ReviewRow[]) =>
  [...rows].sort((a, b) => rowAt(a) - rowAt(b));

/** The live Volume bot's trades of the day: real ones, else the dry run's. */
function volumeLive(live: VolumeDay): LiveVolumeTrade[] {
  const day = live.trades.filter(
    (t) => t.day === live.day && t.leg && t.leg.bought > 0,
  );
  const real = day.filter((t) => !t.dry);
  return real.length ? real : day;
}

/** The Volume bot's day: live trades against the backtest's account trades. */
export function compareVolume(
  live: VolumeDay,
  account: VolumeAccount,
  signals: readonly VolumeSignal[],
  stocks: number,
): Comparison {
  const date = live.day;
  const openMs = newYorkToUtc(date, 570);
  const liveRows = volumeLive(live).map((t) => {
    const leg = t.leg!;
    const buys = leg.orders.filter(
      (o) => o.side === "buy" && o.settled && o.price !== undefined,
    );
    const firstBuy = buys[0];
    const realBuys = buys.map((o) => mid(o.fillBook ?? o.book));
    const paidReal =
      realBuys.every((x) => x !== null) && buys.length
        ? buys.reduce((s, o, i) => s + realBuys[i]! * o.qty, 0) /
          buys.reduce((s, o) => s + o.qty, 0)
        : null;
    const side = liveSide({
      ref: t.id,
      contract: leg.contract,
      broker: null,
      dry: t.dry,
      version: t.version ?? null,
      entryAt: firstBuy?.at ?? t.openedAt,
      qty: leg.bought,
      paidPaper: leg.cost,
      paidReal,
      exits: leg.orders
        .filter((o) => o.side === "sell" && o.settled && o.price !== undefined)
        .map((o) => ({
          at: o.at,
          qty: o.qty,
          paper: o.price!,
          real: mid(o.fillBook ?? o.book),
          reason: o.reason,
        })),
      open: t.phase !== "closed",
    });
    const second = t.alertSecond ?? (t.alertMinute + 1) * 60;
    return {
      side,
      symbol: t.symbol,
      right: t.side,
      kind: t.shock ? "shock" : "plan",
      at: openMs + second * 1000,
      broker: null,
    };
  });
  const btRows = account.trades
    .filter((a) => a.signal.date === date && a.status === "taken")
    .map((a) => {
      const s = a.signal;
      const tr = s.trade!;
      const entryAt = openMs + (tr.sideSecond + 2) * 1000;
      const side: BacktestSide = {
        contract: tr.contract,
        entryAt,
        entryPrice: tr.buy,
        exits: [
          {
            at: newYorkToUtc(date, 570 + tr.exitMinute + 1),
            share: 1,
            price: tr.sell,
            reason: tr.exitReason,
          },
        ],
        open: false,
        ret: a.ret * 100,
        priced: `${tr.buyPriced}/${tr.sellPriced}`,
        account: a.status,
        delta: tr.delta ?? null,
        volume30: null,
        simPaid: a.qty * tr.buy * 100,
      };
      return {
        a,
        side,
        symbol: s.symbol,
        right: tr.right,
        kind: s.kind,
        at: openMs + s.second * 1000,
      };
    });
  const { pairs, liveOnly, btOnly } = pairUp(liveRows, btRows, volumeWindow);
  const refused = account.trades.filter(
    (a) => a.signal.date === date && a.status !== "taken",
  );
  const rows: ReviewRow[] = [
    ...pairs.map(([l, b]) => ({
      key: `${l.symbol}|${l.side.ref}`,
      symbol: l.symbol,
      right: l.right,
      kind: l.kind,
      match: "both" as const,
      why: null,
      live: l.side,
      backtest: b.side,
      ...gaps(l.side, b.side),
    })),
    ...liveOnly.map((l) => {
      const near = signals.find(
        (s) =>
          s.symbol === l.symbol &&
          s.date === date &&
          Math.abs(openMs + s.second * 1000 - l.at) <= volumeWindow,
      );
      const cut = refused.find(
        (a) =>
          a.signal.symbol === l.symbol &&
          Math.abs(openMs + a.signal.second * 1000 - l.at) <= volumeWindow,
      );
      let why = "no alert in the backtest";
      if (cut) why = `backtest account refused: ${cut.status}`;
      else if (near)
        why = `backtest: ${near.outcome}${near.detail ? ` (${near.detail})` : ""}`;
      return oneSided(
        l.symbol,
        l.side.ref,
        l.right,
        l.kind,
        "live-only",
        why,
        l.side,
        null,
      );
    }),
    ...btOnly.map((b) => {
      const sig = live.signals.find(
        (s) =>
          s.symbol === b.symbol &&
          Math.abs(newYorkToUtc(date, 570 + s.minute + 1) - b.at) <=
            volumeWindow,
      );
      const why = sig
        ? `live: ${sig.outcome}${sig.detail ? ` (${sig.detail})` : ""}`
        : "live: no alert";
      return oneSided(
        b.symbol,
        b.a.signal.id,
        b.right,
        b.kind,
        "backtest-only",
        why,
        null,
        b.side,
      );
    }),
  ];
  const notes: string[] = [];
  if (live.trades.some((t) => t.day === date && t.dry))
    notes.push("Some live trades are a dry run (no orders).");
  return {
    bot: "volume",
    date,
    version: live.trades.find((t) => t.version)?.version ?? null,
    stocks,
    rows: sortRows(rows),
    summary: summarize(rows),
    accounts: accountsOf(
      ["alpaca"],
      rows,
      btRows.map((b) => b.side),
    ),
    notes,
    evidence: {
      live: live.signals.filter((x) => x.day === date),
      backtest: signals
        .filter((x) => x.date === date && x.outcome !== "traded")
        .map((x) => ({
          symbol: x.symbol,
          kind: x.kind,
          second: x.second,
          alert: x.alert,
          outcome: x.outcome,
          detail: x.detail,
        })),
      settings: live.settings,
    },
  };
}

// ---- the stored reviews ----

export type ReviewStatus = "running" | "compared" | "failed";

/** The written analysis (the end-of-day skill). */
export const differenceClasses = [
  "live bug",
  "backtest bug",
  "pick",
  "data",
  "expected",
  "unknown",
] as const;
export type DifferenceClass = (typeof differenceClasses)[number];

/** One difference and its cause (the end-of-day skill's "find the cause" step). */
export interface Difference {
  class: DifferenceClass;
  title: string; // a few words: "COIN: a different strike"
  why: string; // the cause in one or two plain sentences
  evidence: string; // the record or the file:line it rests on
  action: string; // what to do: nothing, a test, a fix to propose
  symbols: string[]; // the stocks it concerns, for the trade cards
}

export interface ReviewAnalysis {
  verdict: Verdict;
  headline: string;
  markdown: string;
  differences: Difference[];
  writtenAt: number;
}

export interface DayReview {
  bot: ReviewBot;
  date: string;
  status: ReviewStatus;
  jobId: string | null;
  startedAt: number;
  updatedAt: number;
  error: string | null;
  comparison: Comparison | null;
  analysis: ReviewAnalysis | null;
}

export const maxAnalysisChars = 60000;

export class D1DayReviews {
  // True once the table exists. Never the promise itself: on Workers a D1
  // call started by one request hangs forever when another awaits it.
  private ready = false;
  constructor(private readonly db: D1Like) {}

  private async init() {
    if (this.ready) return;
    await this.db
      .prepare(
        "CREATE TABLE IF NOT EXISTS bot_day_reviews (bot TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL, " +
          "job_id TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT, " +
          "comparison TEXT, analysis TEXT, PRIMARY KEY (bot, date))",
      )
      .run();
    this.ready = true;
  }

  async get(bot: ReviewBot, date: string): Promise<DayReview | null> {
    await this.init();
    const { results } = await this.db
      .prepare("SELECT * FROM bot_day_reviews WHERE bot = ? AND date = ?")
      .bind(bot, date)
      .all<ReviewRowDb>();
    return results[0] ? fromDb(results[0]) : null;
  }

  /** The latest days first, without the rows of each comparison. */
  async list(bot: ReviewBot, limit: number): Promise<DayReview[]> {
    await this.init();
    const { results } = await this.db
      .prepare(
        "SELECT * FROM bot_day_reviews WHERE bot = ? ORDER BY date DESC LIMIT ?",
      )
      .bind(bot, limit)
      .all<ReviewRowDb>();
    return results.map(fromDb);
  }

  async put(r: DayReview) {
    await this.init();
    await this.db
      .prepare(
        "INSERT INTO bot_day_reviews (bot, date, status, job_id, started_at, updated_at, error, comparison, analysis) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (bot, date) DO UPDATE SET status = excluded.status, " +
          "job_id = excluded.job_id, started_at = excluded.started_at, updated_at = excluded.updated_at, " +
          "error = excluded.error, comparison = excluded.comparison, analysis = excluded.analysis",
      )
      .bind(
        r.bot,
        r.date,
        r.status,
        r.jobId,
        r.startedAt,
        r.updatedAt,
        r.error,
        r.comparison ? JSON.stringify(r.comparison) : null,
        r.analysis ? JSON.stringify(r.analysis) : null,
      )
      .run();
  }
}

interface ReviewRowDb {
  bot: string;
  date: string;
  status: string;
  job_id: string | null;
  started_at: number;
  updated_at: number;
  error: string | null;
  comparison: string | null;
  analysis: string | null;
}

function fromDb(r: ReviewRowDb): DayReview {
  return {
    bot: r.bot as ReviewBot,
    date: r.date,
    status: r.status as ReviewStatus,
    jobId: r.job_id,
    startedAt: Number(r.started_at),
    updatedAt: Number(r.updated_at),
    error: r.error,
    comparison: r.comparison ? (JSON.parse(r.comparison) as Comparison) : null,
    analysis: r.analysis ? (JSON.parse(r.analysis) as ReviewAnalysis) : null,
  };
}

/** The analysis as sent by the skill, checked; or the reason it is refused. */
export function parseAnalysis(
  input: unknown,
  now: number,
): ReviewAnalysis | string {
  const o = input as Partial<ReviewAnalysis> | null;
  const verdicts: Verdict[] = [
    "optimistic",
    "pessimistic",
    "on target",
    "no trades",
  ];
  if (!o || typeof o !== "object") return "analysis must be an object";
  if (!verdicts.includes(o.verdict as Verdict))
    return `verdict must be one of: ${verdicts.join(", ")}`;
  if (typeof o.headline !== "string" || !o.headline.trim())
    return "headline must be a sentence";
  if (typeof o.markdown !== "string" || !o.markdown.trim())
    return "markdown must be the analysis";
  if (o.headline.length + o.markdown.length > maxAnalysisChars)
    return "the analysis is too long";
  const differences: Difference[] = [];
  const given = (o as { differences?: unknown }).differences ?? [];
  if (!Array.isArray(given)) return "differences must be a list";
  for (const d of given.slice(0, 30)) {
    const x = d as Partial<Difference> | null;
    if (!x || !differenceClasses.includes(x.class as DifferenceClass))
      return `each difference needs a class: ${differenceClasses.join(", ")}`;
    const text = (v: unknown) =>
      typeof v === "string" ? v.trim().slice(0, 600) : "";
    if (!text(x.title) || !text(x.why))
      return "each difference needs a title and a why";
    differences.push({
      class: x.class as DifferenceClass,
      title: text(x.title),
      why: text(x.why),
      evidence: text(x.evidence),
      action: text(x.action),
      symbols: Array.isArray(x.symbols)
        ? x.symbols.map((v) => String(v).toUpperCase()).slice(0, 10)
        : [],
    });
  }
  return {
    verdict: o.verdict as Verdict,
    headline: o.headline.trim().slice(0, 300),
    markdown: o.markdown,
    differences,
    writtenAt: now,
  };
}

/** A review is for a session: one with a core close, already over. */
export function isReviewDay(date: string, now: number): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const close = coreClose(date);
  if (close === null) return false;
  return now >= newYorkToUtc(date, close);
}
