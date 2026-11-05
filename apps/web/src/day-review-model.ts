import type {
  DayReview,
  Difference,
  DifferenceClass,
  LiveSide,
  ReviewRow,
  Verdict,
} from "../../../packages/market-data/src/day-review.js";
import type { ClosedTrade } from "../../../packages/trading/src/portfolio.js";

// The Analyse page (the user, 2026-11-05): each evening's end-of-day review
// of a bot, live against the app's backtest. The analysis is written in
// markdown by the end-of-day skill; it is shown as plain text blocks, never
// as HTML.

export const verdictWords: Record<Verdict, string> = {
  optimistic: "Backtest too optimistic",
  pessimistic: "Backtest too pessimistic",
  "on target": "Backtest on target",
  "no trades": "No trades to judge",
};

export const verdictShort: Record<Verdict, string> = {
  optimistic: "BT TOO HIGH",
  pessimistic: "BT TOO LOW",
  "on target": "ON TARGET",
  "no trades": "NO TRADES",
};

export const verdictTone: Record<Verdict, string> = {
  optimistic: "red",
  pessimistic: "amber",
  "on target": "green",
  "no trades": "grey",
};

/** What a review's status means for the reader. */
export function statusWords(r: DayReview): string {
  if (r.status === "running") return "The backtest of the day is running…";
  if (r.status === "failed")
    return `The review failed: ${r.error ?? "unknown"}`;
  if (!r.analysis) return "Compared; the written analysis is not in yet.";
  return "";
}

/** The verdict shown: the written one, else the comparison's. */
export function shownVerdict(r: DayReview): Verdict | null {
  return r.analysis?.verdict ?? r.comparison?.summary.verdict ?? null;
}

export const matchWords: Record<ReviewRow["match"], string> = {
  both: "both",
  "live-only": "bot only",
  "backtest-only": "backtest only",
};

/** "+1.2" / "−0.4", or "—" for nothing. */
export function signed(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "−";
  return `${sign}${Math.abs(n).toFixed(digits)}`;
}

export const price = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n.toFixed(2);

/** The average of a side's exits, by quantity or share; null when none. */
export function averageExit(
  exits: readonly {
    price?: number;
    paper?: number;
    qty?: number;
    share?: number;
  }[],
): number | null {
  let weight = 0;
  let sum = 0;
  for (const e of exits) {
    const w = e.qty ?? e.share ?? 0;
    const p = e.price ?? e.paper;
    if (p === undefined) continue;
    weight += w;
    sum += p * w;
  }
  return weight > 0 ? sum / weight : null;
}

export type Block =
  | { kind: "heading"; level: 2 | 3 | 4; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "paragraph"; text: string };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** Markdown as blocks: headings, lists, pipe tables and paragraphs. */
export function markdownBlocks(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1]!.length;
      let level: 2 | 3 | 4 = 4;
      if (depth <= 2) level = 2;
      else if (depth === 3) level = 3;
      out.push({ kind: "heading", level, text: heading[2]!.trim() });
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push({ kind: "list", items });
      continue;
    }
    const isRule = (l: string | undefined) =>
      l !== undefined && /^\s*\|?\s*:?-{3,}/.test(l);
    if (line.trim().startsWith("|") && isRule(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        rows.push(cells(lines[i]!));
        i++;
      }
      out.push({ kind: "table", head, rows });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,4})\s/.test(lines[i]!) &&
      !/^\s*[-*]\s+/.test(lines[i]!) &&
      !lines[i]!.trim().startsWith("|")
    ) {
      para.push(lines[i]!.trim());
      i++;
    }
    out.push({ kind: "paragraph", text: para.join(" ") });
  }
  return out;
}

/** A line's **bold** and `code` spans, the rest plain. */
export function inlineSpans(
  text: string,
): { kind: "text" | "bold" | "code"; text: string }[] {
  const out: { kind: "text" | "bold" | "code"; text: string }[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last)
      out.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "bold", text: m[1] });
    else out.push({ kind: "code", text: m[2]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

// ---- the page's figures (DayReviews.tsx) ----

export interface PerfPoint {
  date: string;
  bot: number; // the day's $, at market
  backtest: number; // the day's $, the backtest at the bot's size
  cumBot: number;
  cumBacktest: number;
  verdict: Verdict | null;
}

/** The compared days, oldest first, for one account: the day's $ and the running sums. */
export function performance(
  reviews: readonly DayReview[],
  broker: string,
): PerfPoint[] {
  let cumBot = 0;
  let cumBacktest = 0;
  const out: PerfPoint[] = [];
  const days = reviews
    .filter((r) => r.comparison)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const r of days) {
    const a = r.comparison!.accounts?.find((x) => x.broker === broker);
    if (!a) continue;
    cumBot += a.bot;
    cumBacktest += a.backtest;
    out.push({
      date: r.date,
      bot: a.bot,
      backtest: a.backtest,
      cumBot,
      cumBacktest,
      verdict: shownVerdict(r),
    });
  }
  return out;
}

/** The accounts the reviews have, the first one first ("alpaca" before "ibkr"). */
export function accountsIn(reviews: readonly DayReview[]): string[] {
  const all = new Set<string>();
  for (const r of reviews)
    for (const a of r.comparison?.accounts ?? []) all.add(a.broker);
  return ["alpaca", "ibkr"].filter((b) => all.has(b));
}

export const accountNames: Record<string, string> = {
  alpaca: "Alpaca",
  ibkr: "IBKR",
};

/** How many days of each verdict. */
export function verdictCounts(
  reviews: readonly DayReview[],
): Record<Verdict, number> {
  const out: Record<Verdict, number> = {
    optimistic: 0,
    pessimistic: 0,
    "on target": 0,
    "no trades": 0,
  };
  for (const r of reviews) {
    const v = shownVerdict(r);
    if (v) out[v]++;
  }
  return out;
}

export const classWords: Record<DifferenceClass, string> = {
  "live bug": "Bot bug",
  "backtest bug": "Backtest bug",
  pick: "Different contract",
  data: "Prices / data",
  expected: "Expected",
  unknown: "Not found yet",
};

export const classTone: Record<DifferenceClass, string> = {
  "live bug": "red",
  "backtest bug": "red",
  pick: "amber",
  data: "amber",
  expected: "grey",
  unknown: "grey",
};

export const isBug = (c: DifferenceClass) =>
  c === "live bug" || c === "backtest bug";

/**
 * The day's differences: the written ones, else the one-sided trades as the
 * comparison found them (before 23:05's analysis, or if it failed).
 */
export function differencesOf(r: DayReview): Difference[] {
  if (r.analysis?.differences?.length) return r.analysis.differences;
  return (r.comparison?.rows ?? [])
    .filter((x) => x.match !== "both")
    .map((x) => ({
      class: "unknown" as const,
      title: `${x.symbol}: ${x.match === "live-only" ? "only the bot traded" : "only the backtest traded"}`,
      why: x.why ?? "",
      evidence: "",
      action: "",
      symbols: [x.symbol],
      accounts: [],
    }));
}

export function bugCount(r: DayReview): number {
  return (r.analysis?.differences ?? []).filter((d) => isBug(d.class)).length;
}

const weekdayDay = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "short",
  day: "numeric",
  month: "short",
});
/** "Wed 4 Nov" from a session date. */
export const dayLabel = (date: string) =>
  weekdayDay.format(Date.parse(`${date}T12:00:00Z`));

/** An OCC contract in words: "Call 160 · 6 Nov". */
export function contractWords(contract: string): string {
  const m = /^([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(contract);
  if (!m) return contract;
  const strike = Number(m[6]) / 1000;
  const expiry = weekdayDay
    .format(Date.parse(`20${m[2]}-${m[3]}-${m[4]}T12:00:00Z`))
    .replace(/^\w+ /, "");
  const right = m[5] === "C" ? "Call" : "Put";
  return `${right} ${strike} · ${expiry}`;
}

/** The bot's side of a trade as the trade window reads it; null while it is held. */
export function closedTradeOf(
  symbol: string,
  live: LiveSide,
): ClosedTrade | null {
  if (live.open || !live.exits.length) return null;
  const m = /^[A-Z.]+(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(live.contract);
  const sold = live.exits.reduce((s, e) => s + e.qty, 0);
  const exit = live.exits.reduce((s, e) => s + e.paper * e.qty, 0) / sold;
  const last = Math.max(...live.exits.map((e) => e.at));
  let option: ClosedTrade["option"] = null;
  if (m)
    option = {
      right: m[4] === "C" ? "call" : "put",
      strike: Number(m[5]) / 1000,
      expiry: `20${m[1]}-${m[2]}-${m[3]}`,
    };
  return {
    symbol: live.contract,
    underlying: symbol,
    option,
    openedAt: new Date(live.entryAt).toISOString(),
    closedAt: new Date(last).toISOString(),
    qty: live.qty,
    entry: live.paidPaper,
    exit,
    pnl: live.pnlPaper ?? 0,
    pnlPct: live.retPaper,
    expired: false,
    fills: [
      {
        side: "buy",
        at: new Date(live.entryAt).toISOString(),
        qty: live.qty,
        price: live.paidPaper,
      },
      ...live.exits.map((e) => ({
        side: "sell" as const,
        at: new Date(e.at).toISOString(),
        qty: e.qty,
        price: e.paper,
      })),
    ],
  };
}

/** A trade's one-line result: who did better and by how much. */
export function tradeLine(r: ReviewRow): string {
  if (r.match === "live-only") return "Only the bot traded it";
  if (r.match === "backtest-only") return "Only the backtest traded it";
  if (r.dollarsGap === null) return "Held overnight: judged on a later day";
  const abs = Math.abs(Math.round(r.dollarsGap)).toLocaleString("en-US");
  if (Math.abs(r.dollarsGap) < 1) return "Same result";
  if (r.dollarsGap > 0) return `The backtest made $${abs} more`;
  return `The bot made $${abs} more`;
}

// ---- the day's ledger (one row a trade) ----

export interface LedgerRow {
  row: ReviewRow;
  account: string | null;
  botContract: string | null;
  btContract: string | null;
  otherContract: boolean; // the two sides bought different contracts
  botEntryAt: number | null;
  btEntryAt: number | null;
  botPaper: number | null; // the bot's buy fill
  botBid: number | null;
  botAsk: number | null;
  botBuy: number | null; // at market: the book's mid, else the fill
  btBuy: number | null;
  botExitAt: number | null; // the last sale
  btExitAt: number | null;
  botSales: number;
  btSales: number;
  botSell: number | null; // the average sale at market
  btSell: number | null;
  botRet: number | null;
  btRet: number | null;
  botPnl: number | null;
  estimate: boolean; // the backtest priced on the option's trades
  open: boolean;
}

const lastAt = (xs: readonly { at: number }[]) =>
  xs.length ? Math.max(...xs.map((x) => x.at)) : null;

/** A trade's numbers side by side. */
export function ledgerRow(r: ReviewRow): LedgerRow {
  const l = r.live;
  const b = r.backtest;
  let botSell: number | null = null;
  if (l && l.exits.length)
    botSell = averageExit(
      l.exits.map((e) => ({ price: e.real ?? e.paper, qty: e.qty })),
    );
  let btSell: number | null = null;
  if (b && b.exits.length) btSell = averageExit(b.exits);
  const botContract = l?.contract ?? null;
  const btContract = b?.contract ?? null;
  return {
    row: r,
    account: l?.broker ?? null,
    botContract,
    btContract,
    otherContract: Boolean(
      botContract && btContract && botContract !== btContract,
    ),
    botEntryAt: l?.entryAt ?? null,
    btEntryAt: b?.entryAt ?? null,
    botPaper: l?.paidPaper ?? null,
    botBid: l?.entryBook?.bid ?? null,
    botAsk: l?.entryBook?.ask ?? null,
    botBuy: l ? (l.paidReal ?? l.paidPaper) : null,
    btBuy: b?.entryPrice ?? null,
    botExitAt: l ? lastAt(l.exits) : null,
    btExitAt: b ? lastAt(b.exits) : null,
    botSales: l?.exits.length ?? 0,
    btSales: b?.exits.length ?? 0,
    botSell,
    btSell,
    botRet: l?.retReal ?? null,
    btRet: b?.ret ?? null,
    botPnl: l?.pnlReal ?? null,
    estimate: b?.priced === "trades",
    open: Boolean(l?.open || b?.open),
  };
}

/** b against a, %: how much the backtest's price is above the bot's. */
export function pctOver(a: number | null, b: number | null): number | null {
  if (a === null || b === null || a <= 0) return null;
  return (b / a - 1) * 100;
}

/** The strike in words from an OCC contract: "160C". */
export function strikeWords(contract: string | null): string {
  if (!contract) return "—";
  const m = /([CP])(\d{8})$/.exec(contract);
  if (!m) return contract;
  return `${Number(m[2]) / 1000}${m[1]}`;
}

/** The shortest tag of a cause class, for the ledger's column. */
export const classTag: Record<DifferenceClass, string> = {
  "live bug": "BOT BUG",
  "backtest bug": "BT BUG",
  pick: "CONTRACT",
  data: "PRICES",
  expected: "EXPECTED",
  unknown: "OPEN",
};
