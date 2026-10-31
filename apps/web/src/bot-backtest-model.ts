import {
  newYorkToUtc,
  nextSessions,
  previousSessions,
} from "../../../packages/market-data/src/calendar.js";
import type { AccountTrade } from "../../../packages/trading/src/bot/backtest-account.js";
import type {
  SimSkip,
  SimStep,
  SkipReason,
  StockRun,
} from "../../../packages/trading/src/bot/backtest.js";
import type { BotSettings } from "../../../packages/trading/src/bot/settings.js";
import {
  currentVersion,
  ruleKeys,
  versionById,
  type RuleKey,
  type Rules,
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
/** Enough for the paper bot's whole list (its stocks and the favorites). */
export const maxStocks = 100;
/** Requests in flight at once. */
export const parallel = 4;

export type BotId = "main" | "volume";
export const bots: { id: BotId; name: string; ready: boolean }[] = [
  { id: "main", name: "🤖 Main bot", ready: true },
  { id: "volume", name: "🎯 Volume bot", ready: true },
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
      { key: "stockStages", label: "Staged stock exit" },
      { key: "stageHalfS30", label: "Staged exit: half out at", unit: "× S30" },
      {
        key: "stageFullS30",
        label: "Staged exit: the rest out at",
        unit: "× S30",
      },
      { key: "lateHold", label: "Hold late winners (entry 15:00+)" },
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
  skips: readonly Pick<SimSkip, "reason">[],
): { reason: SkipReason; label: string; count: number }[] {
  const by = new Map<SkipReason, number>();
  for (const s of skips) by.set(s.reason, (by.get(s.reason) ?? 0) + 1);
  return [...by]
    .map(([reason, count]) => ({ reason, label: skipWords[reason], count }))
    .sort((a, b) => b.count - a.count);
}

// ---- every signal: bought or not, what the bot saw, what came of it ----

/** One signal of the run (the user, 2026-10-31: "why we did not bought, what the bot saw, what would happen if the bot does gets in"). */
export interface SignalRow {
  key: string;
  symbol: string;
  date: string;
  minute: number;
  right: "C" | "P";
  t: number | null;
  rvol: number | null;
  d2: number | null;
  bonus: boolean;
  pyramid: boolean;
  stock: number | null;
  bought: boolean; // the bot bought it (a limit may still have refused the buy)
  outcome: string; // "Bought", or why not
  reason: SkipReason | "bought";
  detail: string;
  contract: string | null; // OCC: the one bought, looked at, or modelled
  strike: number | null;
  expiry: string | null;
  price: number | null; // the option's last price at the signal, as the pick read it
  boughtAt: number | null; // the backtest's buy: the fill, or the what-if's (a model)
  bid: number | null; // the real book as the signal minute closed, when there is one
  ask: number | null;
  delta: number | null;
  volume30: number | null;
  ret: number | null; // the option's return on what was paid, from its steps
  nights: number | null; // sessions held after the entry day (0 = sold the same day)
  model: boolean; // ret is the Black-Scholes what-if, not the trade
  modelled: boolean; // the what-if's strike and expiry are the model's
  iv: number | null; // the what-if's volatility
  ivFrom: "option" | "stock" | null;
  trade: AccountTrade | null;
}

/** Sessions a position was held after its entry day: 0 when it was sold the same day. */
export function nightsHeld(steps: readonly SimStep[]): number | null {
  if (!steps.length) return null;
  return new Set(steps.map((x) => x.date)).size - 1;
}

/** What the sales got back over what the buy paid, minus 1. */
export function stepsReturn(steps: readonly SimStep[]): number | null {
  const cost = steps[0]?.price;
  if (!cost || cost <= 0) return null;
  const back = steps
    .filter((x) => x.kind === "sell")
    .reduce((sum, x) => sum + x.share * x.price, 0);
  return back / cost - 1;
}

function skipRow(k: SimSkip, i: number): SignalRow {
  const w = k.whatIf ?? null;
  const c = k.contract ?? null;
  return {
    key: `skip|${k.symbol}|${k.date}|${k.minute}|${i}`,
    symbol: k.symbol,
    date: k.date,
    minute: k.minute,
    right: k.right,
    t: k.t ?? null,
    rvol: k.rvol ?? null,
    d2: k.d2 ?? null,
    bonus: k.bonus ?? false,
    pyramid: k.pyramid,
    stock: k.stock ?? null,
    bought: false,
    outcome: skipWords[k.reason],
    reason: k.reason,
    detail: k.detail,
    contract: c?.symbol ?? w?.contract ?? null,
    strike: c?.strike ?? w?.strike ?? null,
    expiry: c?.expiry ?? w?.expiry ?? null,
    price: c?.price ?? null,
    boughtAt: w?.steps[0]?.price ?? null,
    bid: c?.book?.bid ?? null,
    ask: c?.book?.ask ?? null,
    delta: c?.delta ?? null,
    volume30: c?.volume30 ?? null,
    ret: w?.ret ?? null,
    nights: w ? nightsHeld(w.steps) : null,
    model: w !== null,
    modelled: w?.modelled ?? false,
    iv: w?.iv ?? null,
    ivFrom: w?.ivFrom ?? null,
    trade: null,
  };
}

/** Every signal of the runs, newest first: the bought ones and the skipped ones. */
export function signalRows(
  runs: readonly StockRun[],
  account: readonly AccountTrade[],
): SignalRow[] {
  const byId = new Map(account.map((a) => [a.trade.id, a]));
  const rows: SignalRow[] = [];
  for (const run of runs) {
    for (const t of run.trades) {
      const a = byId.get(t.id) ?? null;
      let outcome = "Bought";
      if (a && a.status !== "taken") outcome = statusWords[a.status];
      rows.push({
        key: `trade|${t.id}`,
        symbol: t.symbol,
        date: t.date,
        minute: t.minute,
        right: t.right,
        t: t.t,
        rvol: t.rvol,
        d2: t.d2,
        bonus: t.bonus,
        pyramid: t.pyramid,
        stock: t.stock,
        bought: true,
        outcome,
        reason: "bought",
        detail: "",
        contract: t.contract,
        strike: t.strike,
        expiry: t.expiry,
        price: t.signalPrice ?? null,
        boughtAt: t.steps[0]?.price ?? null,
        bid: t.book?.bid ?? null,
        ask: t.book?.ask ?? null,
        delta: t.delta,
        volume30: t.volume30,
        ret: stepsReturn(t.steps),
        nights: nightsHeld(t.steps),
        model: false,
        modelled: false,
        iv: null,
        ivFrom: null,
        trade: a,
      });
    }
    run.skips.forEach((k, i) => rows.push(skipRow(k, i)));
  }
  return rows.sort(
    (a, b) => stepMs(b.date, b.minute) - stepMs(a.date, a.minute),
  );
}

/** The real spread at the signal as a share of its middle; null without a book. */
export function spreadPct(r: Pick<SignalRow, "bid" | "ask">): number | null {
  if (r.bid === null || r.ask === null) return null;
  const mid = (r.bid + r.ask) / 2;
  if (!(mid > 0)) return null;
  return (r.ask - r.bid) / mid;
}

const csvCell = (v: string | number | boolean | null) => {
  if (v === null) return "";
  const text = String(v);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
};
const round = (v: number | null, digits: number) =>
  v === null ? null : Number(v.toFixed(digits));

/** The rows as CSV, for a spreadsheet: one line a signal. */
export function signalsCsv(rows: readonly SignalRow[]): string {
  const head = [
    "date",
    "time_ny",
    "symbol",
    "side",
    "t",
    "volume_x",
    "d2",
    "d2_bonus",
    "pyramid",
    "stock",
    "outcome",
    "detail",
    "contract",
    "strike",
    "expiry",
    "price",
    "bought_at",
    "bid",
    "ask",
    "spread_pct",
    "delta",
    "volume30",
    "return",
    "nights",
    "return_is_model",
    "model_strike",
    "model_iv",
    "model_iv_from",
  ];
  const lines = rows.map((r) => {
    const ny = 570 + r.minute;
    const time = `${String(Math.floor(ny / 60)).padStart(2, "0")}:${String(ny % 60).padStart(2, "0")}`;
    return [
      r.date,
      time,
      r.symbol,
      r.right,
      round(r.t, 2),
      round(r.rvol, 2),
      round(r.d2, 2),
      r.bonus,
      r.pyramid,
      round(r.stock, 2),
      r.outcome,
      r.detail,
      r.contract,
      r.strike,
      r.expiry,
      round(r.price, 4),
      round(r.boughtAt, 4),
      r.bid,
      r.ask,
      round(spreadPct(r), 4),
      round(r.delta, 3),
      r.volume30,
      round(r.ret, 4),
      r.nights,
      r.model,
      r.modelled,
      round(r.iv, 3),
      r.ivFrom,
    ]
      .map(csvCell)
      .join(",");
  });
  return [head.join(","), ...lines].join("\n") + "\n";
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

/** A guess at one part's time before any has come back. */
const firstPartMs = 12000;

export interface RunClock {
  fraction: number; // of the run, estimated, 0..1
  done: number; // of the run, finished parts, 0..1
  at: number; // ms: the moment in the period the run has about reached
  leftMs: number | null; // estimated, null before the first part
}

/**
 * Where a run has about reached, for the loader: the parts' pace so far,
 * spread over the period's sessions (parts run in time order), never past
 * the parts still in flight.
 */
export function runClock(
  busy: { done: number; total: number; startedAt: number; lastDoneAt: number },
  sessions: readonly string[],
  now: number,
  inFlight = parallel,
  reached = 0, // the fraction already shown: a clock does not go back
): RunClock {
  const total = Math.max(1, busy.total);
  // Parts a millisecond: the pace so far, weighed with a guessed first round,
  // so a few quick parts (cached bars) do not fling the clock to the end.
  const rate =
    (busy.done + inFlight) / (busy.lastDoneAt - busy.startedAt + firstPartMs);
  const ceiling = Math.min(total * 0.99, busy.done + inFlight * 0.95);
  const parts = Math.max(
    busy.done,
    reached * total,
    Math.min(ceiling, (now - busy.startedAt) * rate),
  );
  const fraction = parts / total;
  let leftMs: number | null = null;
  if (busy.done > 0)
    leftMs = Math.max(0, (total - busy.done) / rate - (now - busy.lastDoneAt));
  const n = Math.max(1, sessions.length);
  const position = Math.min(n - 1e-6, fraction * n);
  const day = Math.floor(position);
  const date = sessions[day] ?? sessions.at(-1) ?? "";
  const minute = 570 + Math.floor((position - day) * 390);
  return {
    fraction,
    done: busy.done / total,
    at: date ? newYorkToUtc(date, minute) : now,
    leftMs,
  };
}

/** "1:05" from milliseconds. */
export function clockText(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The paper bot as it is now (the user, 2026-10-30: "settings exactly like we
 * have now in paper"): its version and rules, its size and limits, and the
 * stocks it watches today, without the ones it has off.
 */
export function paperSetup(
  settings: BotSettings,
  watching: readonly string[],
): {
  version: string;
  rules: Rules;
  money: Pick<BotSettings, "sizePct" | "maxBuysPerDay" | "maxOpen">;
  tickers: string[];
} {
  const off = new Set(settings.off.map((t) => t.toUpperCase()));
  const rules = Object.fromEntries(
    ruleKeys.map((k) => [k, settings[k]]),
  ) as Rules;
  return {
    // An own label (rules changed by hand) starts from the version it names.
    version: versionById(settings.version)?.id ?? currentVersion,
    rules,
    money: {
      sizePct: settings.sizePct,
      maxBuysPerDay: settings.maxBuysPerDay,
      maxOpen: settings.maxOpen,
    },
    tickers: [...new Set(watching.map((t) => t.toUpperCase()))]
      .filter((t) => !off.has(t))
      .slice(0, maxStocks),
  };
}
