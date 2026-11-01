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
      if (a && a.status !== "taken") why = refusalWords[a.status];
      rows.push({
        key: signal.id,
        signal,
        account: a,
        why,
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
export function outcomeCounts(
  rows: readonly VolumeRow[],
): { outcome: VolumeOutcome; label: string; count: number }[] {
  const n = new Map<VolumeOutcome, number>();
  for (const r of rows)
    if (r.signal.outcome !== "traded")
      n.set(r.signal.outcome, (n.get(r.signal.outcome) ?? 0) + 1);
  return [...n]
    .map(([outcome, count]) => ({
      outcome,
      label: outcomeWords[outcome],
      count,
    }))
    .sort((a, b) => b.count - a.count);
}
