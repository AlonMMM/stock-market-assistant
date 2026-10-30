import {
  newYorkToUtc,
  nextSessions,
  previousSessions,
} from "../../../packages/market-data/src/calendar.js";
import type { AccountTrade } from "../../../packages/trading/src/bot/backtest-account.js";
import type {
  SimSkip,
  SkipReason,
} from "../../../packages/trading/src/bot/backtest.js";
import type {
  RuleKey,
  Rules,
} from "../../../packages/trading/src/bot/versions.js";
import type {
  ClosedTrade,
  TradeFill,
} from "../../../packages/trading/src/portfolio.js";
import {
  botExitWords,
  fillMarkers,
  type ExitRow,
  type Story,
} from "./trade-story-model.js";

// The Backtest page (the user, 2026-10-30): pick a bot, its version, stocks
// and a period, change the settings, run. The run is one request a stock and
// a part of the period on the server (packages/market-data/src/bot-backtest.ts);
// the account is applied here (backtest-account.ts).

/** The sessions one request may cover (the server's maxBacktestSessions). */
export const sessionsPerRequest = 60;
/** Alpaca's option bars start here. */
export const firstDate = "2024-02-01";
export const maxStocks = 40;
/** Requests in flight at once. */
export const parallel = 4;

export type BotId = "main" | "volume";
export const bots: { id: BotId; name: string; ready: boolean }[] = [
  { id: "main", name: "🤖 Main bot", ready: true },
  { id: "volume", name: "🎯 Volume bot (coming soon)", ready: false },
];

export const periods = [
  { id: "1m", label: "1 month", months: 1 },
  { id: "3m", label: "3 months", months: 3 },
  { id: "6m", label: "6 months", months: 6 },
  { id: "1y", label: "1 year", months: 12 },
] as const;
export type PeriodId = (typeof periods)[number]["id"];

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The last `months` months up to `last` (a session), never before the option data. */
export function periodRange(
  months: number,
  last: string,
): { from: string; to: string } {
  const d = new Date(`${last}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  d.setUTCDate(d.getUTCDate() + 1);
  const from = isoDay(d.getTime());
  if (from < firstDate) return { from: firstDate, to: last };
  return { from, to: last };
}

/** The sessions from `from` to `to`, oldest first. */
export function sessionsBetween(from: string, to: string): string[] {
  if (from > to) return [];
  const start = previousSessions(from, 1)[0]!;
  const out: string[] = [];
  let d = nextSessions(start, 1)[0]!;
  while (d <= to) {
    out.push(d);
    d = nextSessions(d, 1)[0]!;
  }
  return out;
}

/** The period in parts of at most `size` sessions each. */
export function periodParts(
  from: string,
  to: string,
  size = sessionsPerRequest,
): { from: string; to: string }[] {
  const days = sessionsBetween(from, to);
  const out: { from: string; to: string }[] = [];
  for (let i = 0; i < days.length; i += size) {
    const part = days.slice(i, i + size);
    out.push({ from: part[0]!, to: part.at(-1)! });
  }
  return out;
}

/** Tickers typed in any mix of commas and spaces, upper case, each once. */
export function parseTickers(text: string): string[] {
  const out: string[] = [];
  for (const word of text.toUpperCase().split(/[\s,;]+/)) {
    const t = word.trim();
    if (/^[A-Z][A-Z.]{0,5}$/.test(t) && t !== "SPY" && !out.includes(t))
      out.push(t);
  }
  return out;
}

// ---- the rules form ----

export interface RuleField {
  key: RuleKey;
  label: string;
  unit?: string;
  // Shown under the switch or number; what it does.
  help?: string;
}

export interface RuleGroup {
  title: string;
  fields: RuleField[];
}

export const ruleGroups: RuleGroup[] = [
  {
    title: "Signal",
    fields: [
      { key: "minT", label: "Strength vs SPY (t)" },
      { key: "minRvol", label: "Volume vs normal", unit: "×" },
      {
        key: "firstEntryMin",
        label: "First entry after the open",
        unit: "min",
      },
      {
        key: "d2Entry",
        label: "D2 bonus entry",
        help: "A lower strength enters when the stock held up on SPY's down minutes.",
      },
      { key: "d2T", label: "D2 bonus: strength (t)" },
      { key: "minD2", label: "D2 bonus: held up (D2)" },
      {
        key: "earlyEntry",
        label: "Early entry",
        help: "Live: checked inside the minute. The backtest reads it at the minute's close.",
      },
    ],
  },
  {
    title: "News filter",
    fields: [
      { key: "skipEarnings", label: "Skip earnings reaction days" },
      { key: "skipPremarket", label: "Skip a busy pre-market (4× normal)" },
    ],
  },
  {
    title: "Contract",
    fields: [
      { key: "delta", label: "Delta" },
      { key: "maxDte", label: "Expiry up to", unit: "days" },
      { key: "minPrice", label: "Cheapest contract", unit: "$" },
      { key: "minVolume", label: "Least traded in 30 min", unit: "contracts" },
      {
        key: "cheapFallback",
        label: "Cheap fallback",
        help: "Under the cheapest price, the nearest strike toward the money that costs it.",
      },
      { key: "lowFloorSymbols", label: "Stocks with a lower floor" },
      { key: "lowFloorPrice", label: "Their cheapest contract", unit: "$" },
    ],
  },
  {
    title: "Pyramid",
    fields: [
      {
        key: "pyramid",
        label: "Pyramid after a D2 entry",
        help: "Adds a position when the stock reaches the full signal and the first is up.",
      },
      { key: "pyramidSharePct", label: "Its size", unit: "% of a trade" },
    ],
  },
  {
    title: "Exits",
    fields: [
      { key: "checks", label: "10- and 20-minute checks" },
      { key: "stopPct", label: "Stop", unit: "%" },
      {
        key: "restStopPct",
        label: "Stop on the rest after the half",
        unit: "%",
      },
      { key: "sellOnWeakness", label: "Sell when the strength is gone" },
      { key: "weaknessT", label: "Strength gone at (t)" },
      { key: "sellFailedBreak", label: "Sell on a failed break" },
      { key: "holdFromPct", label: "Hold overnight from", unit: "% up" },
      { key: "maxNights", label: "Most nights held" },
      {
        key: "nightCapPct",
        label: "Most held overnight",
        unit: "% of the account",
      },
    ],
  },
];

// ---- words ----

export const skipWords: Record<SkipReason, string> = {
  earnings: "Earnings reaction day",
  premarket: "Busy pre-market",
  no_expiry: "No expiry in range",
  no_strikes: "No strikes in range",
  no_prices: "No option prices",
  too_cheap: "Contract too cheap",
  illiquid: "Contract too thin",
  no_fill: "No trade to fill on",
};

export function skipCounts(
  skips: readonly SimSkip[],
): { reason: SkipReason; label: string; count: number }[] {
  const by = new Map<SkipReason, number>();
  for (const s of skips) by.set(s.reason, (by.get(s.reason) ?? 0) + 1);
  return [...by]
    .map(([reason, count]) => ({ reason, label: skipWords[reason], count }))
    .sort((a, b) => b.count - a.count);
}

export const statusWords: Record<AccountTrade["status"], string> = {
  taken: "",
  "day-limit": "Not bought: the day's buys were used",
  "open-limit": "Not bought: too many open positions",
  "too-small": "Not bought: the size buys no contract",
};

const sideWord = (right: "C" | "P") => (right === "C" ? "call" : "put");

/** When a step happened: the start of its New York session minute, in ms. */
export const stepMs = (date: string, minute: number) =>
  newYorkToUtc(date, 570 + minute);

/** The exit that closed the trade, in words. */
export function exitTitle(a: AccountTrade, rules: Rules): string {
  if (a.open) return "Still held";
  const last = [...a.fills].reverse().find((f) => f.kind === "sell");
  if (!last) return "—";
  return exitWords(last.reason, rules, a.trade.watch).title;
}

function exitWords(
  reason: string,
  rules: Rules,
  watch: { name: string; level: number } | null,
) {
  if (reason === "data-end")
    return {
      title: "Still held",
      text: "The data ended with the position held: valued at its last price.",
    };
  if (reason === "carry") return { title: "Held overnight", text: "" };
  return botExitWords(reason, rules, watch);
}

/** A backtest trade as a closed trade, for the History window's chart and fills. */
export function closedTradeOf(a: AccountTrade): ClosedTrade {
  const t = a.trade;
  const fills: TradeFill[] = a.fills
    .filter((f) => f.kind !== "carry")
    .map((f) => ({
      side: f.kind === "buy" ? "buy" : "sell",
      at: new Date(stepMs(f.date, f.minute)).toISOString(),
      qty: f.qty,
      price: f.price,
    }));
  const sales = fills.filter((f) => f.side === "sell");
  const sold = sales.reduce((n, f) => n + f.qty, 0);
  const last = sales.at(-1) ?? fills[0]!;
  return {
    symbol: t.contract,
    underlying: t.symbol,
    option: {
      right: t.right === "C" ? "call" : "put",
      strike: t.strike,
      expiry: t.expiry,
    },
    openedAt: fills[0]!.at,
    closedAt: last.at,
    qty: a.qty,
    entry: a.qty ? a.paid / a.qty / 100 : 0,
    exit: sold ? a.proceeds / sold / 100 : 0,
    pnl: a.pnl,
    pnlPct: a.retPct,
    expired: false,
    fills,
  };
}

/** The trade's story for the History window: why it entered, each exit, the lines and markers. */
export function backtestStory(
  a: AccountTrade,
  rules: Rules,
  version: string,
): Story {
  const t = a.trade;
  const closed = closedTradeOf(a);
  const strength = t.right === "C" ? "strength" : "weakness";
  const signalMs = stepMs(t.date, t.minute);
  const entry: string[] = [];
  if (t.pyramid)
    entry.push(
      `Pyramid: the full signal (t ${t.t.toFixed(1)}, rule ${rules.minT}+) came after the D2 entry while it was up; ${rules.pyramidSharePct}% of a trade's size in a fresh pick.`,
    );
  else if (t.bonus)
    entry.push(
      `D2 bonus signal: ${t.symbol} showed ${strength} against SPY with t ${t.t.toFixed(1)} (bonus rule ${rules.d2T}+) and held up on SPY's down minutes (D2 ${t.d2 === null ? "—" : t.d2.toFixed(1)}, rule ${rules.minD2}+), on volume ${t.rvol.toFixed(1)}× normal.`,
    );
  else
    entry.push(
      `Signal: ${t.symbol} showed ${strength} against SPY with t ${t.t.toFixed(1)} (rule ${rules.minT}+) on volume ${t.rvol.toFixed(1)}× normal (rule ${rules.minRvol}×+).`,
    );
  entry.push(
    `The contract: ${t.symbol} ${t.strike} ${sideWord(t.right)}, expiry ${t.expiry}, delta ${t.delta.toFixed(2)} (target ${rules.delta}), ${t.volume30} contracts in the 30 minutes before.${t.fallback ? " Chosen by the cheap fallback." : ""}`,
  );
  if (t.watch)
    entry.push(
      `Level ahead: ${t.watch.name} at $${t.watch.level.toFixed(2)}, watched for a failed break.`,
    );
  if (a.status !== "taken") entry.push(statusWords[a.status]);
  const exits: ExitRow[] = a.fills
    .filter((f) => f.kind !== "buy")
    .map((f) => {
      const words = exitWords(f.reason, rules, t.watch);
      return {
        ms: stepMs(f.date, f.minute),
        qty: f.qty,
        price: f.kind === "carry" ? null : f.price,
        ...words,
      };
    });
  const markers = fillMarkers(closed);
  markers.push({
    kind: "signal",
    pane: "stock",
    at: { date: t.date, minute: t.minute },
    ms: signalMs,
    price: null,
    label: "signal",
  });
  return {
    bot: true,
    version,
    entryTitle: "Why the bot entered",
    entry,
    exits,
    paid: closed.entry,
    stop: Number((closed.entry * (1 - rules.stopPct / 100)).toFixed(2)),
    stopLabel: `stop −${rules.stopPct}%`,
    stockEntry: t.stock,
    wall: t.watch
      ? { name: t.watch.name, level: t.watch.level, unit: null }
      : null,
    right: t.right,
    rule: rules.minT,
    markers,
    decision: null,
    entryQuote: null,
  };
}
