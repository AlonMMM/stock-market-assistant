import { shortRisks } from "../../../packages/trading/src/safety.js";
import type { Trader } from "./traders.js";

// The never-short rule (user, 2026-10-10) for brokers that do not refuse a
// sell that opens a short position themselves (IBKR). Every minute the
// account's positions and open orders are checked; a finding is sent at once
// and repeated every 15 minutes until it is gone. The Worker's cron still
// watches the Alpaca account (docs/features/multi-user-ibkr.md, phase 3).

export const shortRepeatMs = 15 * 60_000;

interface Last {
  problems: string;
  at: number;
}

export class ShortWatch {
  private readonly last = new Map<string, Last>();
  constructor(
    private readonly log: (line: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Checks one account; returns what it found. */
  async check(trader: Trader): Promise<string[]> {
    const { broker, scope, notifier } = trader;
    const problems = shortRisks(
      [
        ...(await broker.positions()),
        ...((await broker.stockPositions?.()) ?? []),
      ],
      await broker.openOrders(),
    );
    const text = problems.join("\n");
    const before = this.last.get(scope) ?? { problems: "", at: 0 };
    const now = this.now();
    if (
      text &&
      (text !== before.problems || now - before.at >= shortRepeatMs)
    ) {
      const sent = await notifier.alert(
        `SHORT POSITION RISK (${trader.account.broker}${broker.capabilities.paper ? ", paper" : ""})`,
        problems,
      );
      if (sent.ok) this.last.set(scope, { problems: text, at: now });
      else this.log(`short alert of ${scope} NOT SENT: ${sent.error}`);
    } else if (!text && before.problems) {
      const sent = await notifier.alert(
        `Short position risk is gone (${trader.account.broker})`,
        ["No short positions and no oversized sell orders."],
      );
      if (sent.ok) this.last.set(scope, { problems: "", at: now });
    }
    return problems;
  }
}
