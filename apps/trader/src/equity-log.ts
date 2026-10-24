import {
  coreClose,
  newYork,
} from "../../../packages/market-data/src/calendar.js";
import type { TradeStore } from "./store.js";
import type { Trader } from "./traders.js";

// The daily equity history for brokers that have none of their own (IBKR:
// TWS only tells the current value). Every minute of a trading day, from the
// open on, the account's value is written under that New York date; the last
// write of the day is the close. The risk manager's drawdown brake reads this
// series through the broker's `equityHistory` (docs/tasks/backend-bot-ibkr.md).
// The series starts the day the account is connected: no past, no drawdown.

export class EquityLog {
  constructor(
    private readonly store: TradeStore,
    private readonly log: (line: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether this trader's history is kept here. */
  static keeps(trader: Trader): boolean {
    return trader.broker.capabilities.ownEquityHistory === false;
  }

  /**
   * Records the account's value for today when it is a trading day at or
   * after the open; returns the value written, or null when nothing was.
   */
  async record(trader: Trader): Promise<number | null> {
    if (!EquityLog.keeps(trader)) return null;
    const now = this.now();
    const { date, minute } = newYork(now);
    if (coreClose(date) === null || minute < 570) return null;
    const equity = await trader.broker.equity();
    if (!Number.isFinite(equity) || equity <= 0) {
      this.log(`equity of ${trader.scope} not recorded: read ${equity}`);
      return null;
    }
    this.store.recordEquity(trader.account.id, date, equity, now);
    return equity;
  }
}
