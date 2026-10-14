import type { Decision } from "./explain.js";
import type { ClosedTrade } from "./portfolio.js";

// Joins buy commands (Orders) with the closed trades they opened (History),
// and filters both by Israel date, ticker and result. Pure, so the site
// filters instantly on data it already loaded.

export type TradeResult = "win" | "loss" | "even" | "open";

export interface TradeFilter {
  from?: string; // YYYY-MM-DD, Israel date, inclusive
  to?: string; // YYYY-MM-DD, Israel date, inclusive
  tickers?: string[]; // underlying symbols; empty or absent means all
  result?: "win" | "loss"; // absent means all
}

const israelDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function tradeResult(pnl: number): Exclude<TradeResult, "open"> {
  return pnl > 0 ? "win" : pnl < 0 ? "loss" : "even";
}

function matches(
  filter: TradeFilter,
  time: number,
  underlying: string,
  result: TradeResult | null,
) {
  const day = israelDay.format(time);
  if (filter.from && day < filter.from) return false;
  if (filter.to && day > filter.to) return false;
  if (
    filter.tickers?.length &&
    !filter.tickers.some((t) => t.toUpperCase() === underlying.toUpperCase())
  )
    return false;
  return !filter.result || result === filter.result;
}

/** History: dated by the close, the moment the result became known. */
export function filterTrades(
  trades: ClosedTrade[],
  filter: TradeFilter,
): ClosedTrade[] {
  return trades.filter((t) =>
    matches(filter, Date.parse(t.closedAt), t.underlying, tradeResult(t.pnl)),
  );
}

export interface JournalEntry {
  decision: Decision;
  // The closed trade this buy opened; null while still held or never filled.
  trade: ClosedTrade | null;
  result: TradeResult | null; // null: nothing was bought
}

// A fill lands seconds after its command; allow for clock differences.
const openSlackMs = 5 * 60000;

/**
 * Links each filled buy to the closed trade of the same contract that opened
 * at or after it. A buy that adds to an open position is linked to the trade
 * it added to. Entries keep the decisions' order.
 */
export function journal(
  decisions: Decision[],
  trades: ClosedTrade[],
): JournalEntry[] {
  return decisions.map((decision) => {
    const filled = (decision.result?.filledQty ?? 0) > 0;
    if (!filled) return { decision, trade: null, result: null };
    const symbol = decision.explanation.contract.symbol;
    const trade =
      trades
        .filter(
          (t) =>
            t.symbol === symbol &&
            Date.parse(t.openedAt) <= decision.at + openSlackMs &&
            Date.parse(t.closedAt) >= decision.at - openSlackMs,
        )
        .sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt))[0] ??
      null;
    return {
      decision,
      trade,
      result: trade ? tradeResult(trade.pnl) : "open",
    };
  });
}

/** Orders: dated by the command. Win/loss needs a closed trade. */
export function filterJournal(
  entries: JournalEntry[],
  filter: TradeFilter,
): JournalEntry[] {
  return entries.filter((e) =>
    matches(
      filter,
      e.decision.at,
      e.decision.explanation.contract.underlying,
      e.result,
    ),
  );
}

/** Tickers to offer in a filter, most traded first. */
export function journalTickers(
  trades: ClosedTrade[],
  decisions: Decision[],
): string[] {
  const counts = new Map<string, number>();
  for (const u of [
    ...trades.map((t) => t.underlying),
    ...decisions.map((d) => d.explanation.contract.underlying),
  ])
    counts.set(u, (counts.get(u) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([u]) => u);
}
