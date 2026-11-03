import type { VolumeBacktestResponse } from "../../../packages/market-data/src/volume-backtest.js";
import type { ClosedTrade } from "../../../packages/trading/src/portfolio.js";
import type {
  PricedBy,
  VolumeAccount,
  VolumeAccountTrade,
  VolumeMoney,
  VolumeOutcome,
  VolumeRefusal,
  VolumeSignal,
} from "../../../packages/trading/src/strangle/backtest.js";
import type { StrangleSettings } from "../../../packages/trading/src/strangle/settings.js";
import { stepMs } from "./bot-backtest-model.js";
import { fillMarkers, type ExitRow, type Story } from "./trade-story-model.js";

// The Volume bot's backtest on the Backtest page (the user, 2026-10-31: "lets
// open the volume for backtesting on the app"): every alert of the run, what
// came of it, and the account over the trades (volumeAccount, applied on the
// page so the money settings need no new run).

/** Why an alert was not traded, in words. */
export const outcomeWords: Record<VolumeOutcome, string> = {
  traded: "Traded",
  earnings: "Earnings reaction day",
  premarket: "Busy pre-market",
  no_prices: "No stock prices",
  no_expiry: "No expiry in range",
  no_side: "No side in time",
  slow_cross: "Side too slow",
  burst: "Burst against the side",
  no_strikes: "No strikes",
  too_cheap: "Contract too cheap",
  thin: "Contract too thin",
  wide_spread: "Spread too wide",
  no_fill: "No fill",
  against_move: "Shock against the day's move",
};

/** Why the account did not take a traded alert. */
export const refusalWords: Record<VolumeRefusal, string> = {
  busy: "The stock's earlier trade was open",
  per_stock: "The stock's trades for the day were used",
  max_trades: "The day's trades were used",
  max_open: "Too many open trades",
  day_loss: "The day's loss limit",
  too_small: "The size buys no contract",
};

/** What priced a buy or a sale, in words. */
export const pricedWords: Record<PricedBy, string> = {
  seconds: "1-second book",
  minutes: "Minute book",
  bars: "Bar model",
};

// The settings the account reads: they change the result at once, no new run.
export const accountKeys = [
  "sizePct",
  "maxTradesPerDay",
  "maxPerStock",
  "maxOpen",
  "dayLossPct",
] as const satisfies readonly (keyof StrangleSettings)[];

/** Whether two settings run the same alerts and trades (the account's own keys aside). */
export function sameRun(a: StrangleSettings, b: StrangleSettings): boolean {
  const skip = new Set<string>(accountKeys);
  for (const key of Object.keys(a) as (keyof StrangleSettings)[]) {
    if (skip.has(key)) continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  }
  return true;
}

export interface VolumeMoneySetup {
  start: number;
  feePerContract: number;
  // The live bot's day limits (trades a day, open trades, the day's loss).
  limits: boolean;
}

export const defaultVolumeMoney: VolumeMoneySetup = {
  start: 100_000,
  feePerContract: 0.62,
  limits: true,
};

/** The account's money from the page: the start and fees, size and limits from the bot's settings. */
export function volumeMoney(
  m: VolumeMoneySetup,
  s: StrangleSettings,
): VolumeMoney {
  return {
    start: m.start,
    sizePct: s.sizePct,
    feePerContract: m.feePerContract,
    maxPerStock: s.maxPerStock,
    limits: m.limits,
    maxTradesPerDay: s.maxTradesPerDay,
    maxOpen: s.maxOpen,
    dayLossPct: s.dayLossPct,
  };
}

/** One alert of the run, as the signals list shows it. */
export interface VolumeRow {
  key: string;
  signal: VolumeSignal;
  // The account's handling of a traded alert; absent for an alert not traded.
  account: VolumeAccountTrade | null;
  why: string; // the outcome or the account's refusal, in words
  // The same as a key: the outcome, or "account:<refusal>" when the rules
  // bought but the account refused it.
  reason: string;
  bought: boolean; // the account took the trade
}

/** Every alert of the runs, newest first, with what the account did with it. */
export function volumeRows(
  runs: readonly VolumeBacktestResponse[],
  account: VolumeAccount | null,
): VolumeRow[] {
  const byId = new Map<string, VolumeAccountTrade>();
  for (const a of account?.trades ?? []) byId.set(a.signal.id, a);
  const rows: VolumeRow[] = [];
  for (const r of runs)
    for (const signal of r.signals) {
      const a = byId.get(signal.id) ?? null;
      let why = outcomeWords[signal.outcome];
      let reason: string = signal.outcome;
      if (a && a.status !== "taken") {
        why = refusalWords[a.status];
        reason = `account:${a.status}`;
      }
      rows.push({
        key: signal.id,
        signal,
        account: a,
        why,
        reason,
        bought: a?.status === "taken",
      });
    }
  return rows.sort(
    (x, y) =>
      y.signal.date.localeCompare(x.signal.date) ||
      y.signal.second - x.signal.second,
  );
}

/** How the taken trades' buys and sales were priced: the real 1-second book, a minute book, or the bars. */
export function pricedCounts(account: VolumeAccount | null): {
  buys: Record<PricedBy, number>;
  sales: Record<PricedBy, number>;
} {
  const buys: Record<PricedBy, number> = { seconds: 0, minutes: 0, bars: 0 };
  const sales: Record<PricedBy, number> = { seconds: 0, minutes: 0, bars: 0 };
  for (const a of account?.trades ?? []) {
    const t = a.signal.trade;
    if (a.status !== "taken" || !t) continue;
    buys[t.buyPriced]++;
    sales[t.sellPriced]++;
  }
  return { buys, sales };
}

/** A taken trade as the P&L chart reads it. */
export function closedVolumeTrade(a: VolumeAccountTrade): ClosedTrade {
  const s = a.signal;
  const t = s.trade!;
  const openedAt = new Date(stepMs(s.date, t.buyMinute)).toISOString();
  const closedAt = new Date(stepMs(s.date, t.exitMinute)).toISOString();
  return {
    symbol: t.contract,
    underlying: s.symbol,
    option: {
      right: t.right === "C" ? "call" : "put",
      strike: t.strike,
      expiry: t.expiry,
    },
    openedAt,
    closedAt,
    qty: a.qty,
    entry: t.buy,
    exit: t.sell,
    pnl: a.pnl,
    pnlPct: a.ret * 100,
    expired: false,
    fills: [
      { side: "buy", at: openedAt, qty: a.qty, price: t.buy },
      { side: "sell", at: closedAt, qty: a.qty, price: t.sell },
    ],
  };
}

/** The session clock of a session second (09:30 New York = 0), New York time. */
const israelSeconds = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function nyClock(second: number): string {
  const total = 9 * 3600 + 30 * 60 + second;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(sec)}`;
}

const csvCell = (v: string | number | null | undefined) => {
  if (v === null || v === undefined) return "";
  const text = String(v);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
};

/** The signals list as CSV (New York times). */
export function volumeCsv(rows: readonly VolumeRow[]): string {
  const head = [
    "date",
    "symbol",
    "alert",
    "time_ny",
    "direction",
    "burst",
    "outcome",
    "why",
    "contract",
    "side_time_ny",
    "buy",
    "buy_priced",
    "sell",
    "sell_priced",
    "exit",
    "qty",
    "pnl",
    "return_pct",
  ];
  const lines = rows.map((r) => {
    const s = r.signal;
    const t = s.trade;
    const taken = r.account?.status === "taken";
    return [
      s.date,
      s.symbol,
      s.kind,
      nyClock(s.second),
      s.alert,
      s.burst === null ? null : s.burst.toFixed(2),
      s.outcome,
      r.why,
      t?.contract,
      t ? nyClock(t.sideSecond) : null,
      t?.buy,
      t?.buyPriced,
      t?.sell,
      t?.sellPriced,
      t?.exitReason,
      taken ? r.account!.qty : null,
      taken ? r.account!.pnl.toFixed(2) : null,
      taken ? (r.account!.ret * 100).toFixed(1) : null,
    ]
      .map(csvCell)
      .join(",");
  });
  return [head.join(","), ...lines].join("\n");
}

/** The outcomes of the alerts not traded, most first. */
export function outcomeCounts(rows: readonly VolumeRow[]): {
  reason: string;
  label: string;
  count: number;
  account: boolean; // the rules bought, the account refused
}[] {
  const n = new Map<string, { label: string; count: number }>();
  for (const r of rows) {
    if (r.bought) continue;
    const got = n.get(r.reason) ?? { label: r.why, count: 0 };
    got.count++;
    n.set(r.reason, got);
  }
  return [...n]
    .map(([reason, { label, count }]) => ({
      reason,
      label,
      count,
      account: reason.startsWith("account:"),
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * A backtest trade's window (the trade story, as the live Volume bot's
 * trades open it): why it was entered, the sale, the paid and the broker stop
 * lines, the alert on the stock pane.
 */
export function volumeBacktestStory(
  a: VolumeAccountTrade,
  s: StrangleSettings,
  safetyStop: boolean,
): Story {
  const sig = a.signal;
  const t = sig.trade!;
  const closed = closedVolumeTrade(a);
  const alertMs = stepMs(sig.date, 0) + sig.second * 1000;
  const kind = sig.kind === "shock" ? "Shock alert" : "Volume alert";
  let bookWords = "";
  if (t.book)
    bookWords = ` (bid / ask ${t.book.bid.toFixed(2)} / ${t.book.ask.toFixed(2)})`;
  const entry = [
    `${kind} ${sig.alert} at ${nyClock(sig.second)} New York${sig.burst === null ? "" : `, burst ${sig.burst.toFixed(2)}`}.`,
    `The side: ${t.right === "C" ? "up, so a call" : "down, so a put"} at ${nyClock(t.sideSecond)}, ${t.toSide} s after the alert, stock ${t.stockIn.toFixed(2)}.`,
    `The leg: ${t.contract}, delta ${t.delta.toFixed(2)}${t.fallback}. Bought ${t.buy.toFixed(2)} on the ${pricedWords[t.buyPriced].toLowerCase()}${bookWords}.`,
  ];
  let title = "The end of the day";
  let text = `Everything out by ${nyClock(s.endMinute * 60)}.`;
  if (t.exitReason === "giveback") {
    title = "The stock's give-back";
    text = `Sold when the stock gave back ${s.giveBackUnits}× its typical 30-minute move from its best, on minute closes, not in the first ${s.noStopMinutes} minutes.`;
  } else if (t.exitReason === "stop") {
    title = "The broker's safety stop";
    text = `The minute's bid reached the stop at −${s.safetyStopPct}% of the price paid.`;
  }
  const exits: ExitRow[] = [
    {
      ms: Date.parse(closed.closedAt),
      qty: a.qty,
      price: t.sell,
      title,
      text: `${text} Sold at the bid on the ${pricedWords[t.sellPriced].toLowerCase()}${t.stockOut === null ? "" : `, stock ${t.stockOut.toFixed(2)}`}.`,
    },
  ];
  const markers = fillMarkers(closed);
  markers.push({
    kind: "signal",
    pane: "stock",
    at: { date: sig.date, minute: sig.minute },
    ms: alertMs,
    price: null,
    // On the chart's own clock, Israel time (user 2026-11-02: SLV read "alert 13:35:40", New York).
    label: `alert ${israelSeconds.format(alertMs)}`,
  });
  return {
    bot: true,
    version: null,
    entryTitle: "Why the volume bot entered",
    entry,
    exits,
    paid: t.buy,
    stop: safetyStop
      ? Number((t.buy * (1 - s.safetyStopPct / 100)).toFixed(2))
      : null,
    stopLabel: `stop −${s.safetyStopPct}%`,
    stockEntry: t.stockIn,
    wall: null,
    right: t.right,
    rule: null,
    markers,
    decision: null,
    entryQuote: t.book
      ? { bid: t.book.bid, ask: t.book.ask, at: Date.parse(closed.openedAt) }
      : null,
  };
}
