// The option's bid and ask at one moment, saved with every bot signal, buy and
// sale (user 2026-10-25): the accounts are paper accounts, whose fills are not
// what a real account would get, so the book at the decision is kept to judge
// the fills against later.

import type { BotBroker } from "../../../packages/trading/src/bot/settings.js";

export interface OptionBook {
  bid: number;
  ask: number;
  at: number; // ms, when the bot read it
  broker: BotBroker; // whose quote it is: alpaca or ibkr
}

/** The book of a quote read at `at` from `broker`; undefined when there is no quote. */
export function bookOf(
  quote: { bid: number; ask: number } | null | undefined,
  at: number,
  broker: BotBroker,
): OptionBook | undefined {
  if (!quote || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask))
    return undefined;
  return { bid: quote.bid, ask: quote.ask, at, broker };
}
