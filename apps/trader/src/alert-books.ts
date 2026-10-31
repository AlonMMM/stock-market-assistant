import type { OptionQuote } from "../../../packages/trading/src/options.js";
import type { BotTrading } from "./bot.js";
import type { StrangleStore } from "./strangle-store.js";

// The option books around every Volume bot alert, traded or not (user
// 2026-10-31: "i want to save every 2 second around the alert + delta 0.1 to
// 0.35"), so its backtest can fill at the real bid and ask instead of a
// model. At the alert the calls and puts of the bot's expiry with |delta|
// 0.10-0.35 are fixed; their bid and ask are then read every 2 seconds for
// 30 minutes. A watch is written every 30 seconds while it runs and at its
// end, so a restart loses at most that much.

export const bookWatch = {
  deltaMin: 0.1,
  deltaMax: 0.35,
  everyMs: 2_000,
  forMs: 30 * 60_000,
  saveEveryMs: 30_000,
};

/** One alert's watch: its contracts and the samples so far. */
export interface AlertBookWatch {
  day: string;
  symbol: string;
  second: number; // the alert's session second (09:30 New York = 0)
  kind: "fast" | "shock";
  expiry: string;
  startedAt: number; // ms
  // Fixed at the alert: OCC symbols and their delta then.
  contracts: { symbol: string; delta: number }[];
  // Each sample: when it was read (ms) and per contract [bid, ask], null when
  // the chain had no quote for it.
  samples: { at: number; books: ([number, number] | null)[] }[];
}

/** The contracts of a chain read with |delta| in the watched range. */
export function watchedContracts(
  quotes: readonly OptionQuote[],
): { symbol: string; delta: number }[] {
  return quotes
    .filter((q) => {
      if (q.delta === null || !Number.isFinite(q.delta)) return false;
      const d = Math.abs(q.delta);
      return d >= bookWatch.deltaMin && d <= bookWatch.deltaMax;
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .map((q) => ({ symbol: q.symbol, delta: q.delta! }));
}

export class AlertBooks {
  private watches = new Map<string, AlertBookWatch>();
  private savedAt = new Map<string, number>();
  private busy = false;
  constructor(
    private readonly o: {
      chain: BotTrading["chain"];
      store: StrangleStore;
      now: () => number;
      log?: (line: string) => void;
    },
  ) {}

  /** Watches running now. */
  get active(): number {
    return this.watches.size;
  }

  /** Starts the watch of one alert; the first sample is read at once. */
  async start(alert: {
    day: string;
    symbol: string;
    second: number;
    kind: "fast" | "shock";
    expiry: string;
  }): Promise<void> {
    const key = `${alert.day}|${alert.symbol}|${alert.second}|${alert.kind}`;
    if (this.watches.has(key)) return;
    const [calls, puts] = await Promise.all([
      this.o.chain(alert.symbol, "call", alert.expiry, alert.expiry),
      this.o.chain(alert.symbol, "put", alert.expiry, alert.expiry),
    ]);
    const contracts = watchedContracts([...calls, ...puts]);
    if (!contracts.length) {
      this.o.log?.(
        `alert books: ${alert.symbol} ${alert.expiry} has no contract with delta ${bookWatch.deltaMin}-${bookWatch.deltaMax}`,
      );
      return;
    }
    const watch: AlertBookWatch = {
      ...alert,
      startedAt: this.o.now(),
      contracts,
      samples: [],
    };
    this.watches.set(key, watch);
    this.sample(watch, [...calls, ...puts]);
    this.save(key, watch);
  }

  /** Every 2 seconds: one sample of each running watch; ends the old ones. */
  async step(): Promise<void> {
    if (this.busy || !this.watches.size) return;
    this.busy = true;
    try {
      await Promise.all(
        [...this.watches].map(async ([key, w]) => {
          const done = this.o.now() - w.startedAt >= bookWatch.forMs;
          if (!done) {
            const [calls, puts] = await Promise.all([
              this.o.chain(w.symbol, "call", w.expiry, w.expiry),
              this.o.chain(w.symbol, "put", w.expiry, w.expiry),
            ]).catch(() => [[], []] as OptionQuote[][]);
            this.sample(w, [...calls!, ...puts!]);
          }
          const due =
            this.o.now() - (this.savedAt.get(key) ?? 0) >=
            bookWatch.saveEveryMs;
          if (done || due) this.save(key, w);
          if (done) {
            this.watches.delete(key);
            this.savedAt.delete(key);
          }
        }),
      );
    } finally {
      this.busy = false;
    }
  }

  private sample(w: AlertBookWatch, quotes: readonly OptionQuote[]) {
    const by = new Map(quotes.map((q) => [q.symbol, q]));
    w.samples.push({
      at: this.o.now(),
      books: w.contracts.map((c) => {
        const q = by.get(c.symbol);
        if (!q || !Number.isFinite(q.bid) || !Number.isFinite(q.ask))
          return null;
        return [q.bid, q.ask];
      }),
    });
  }

  private save(key: string, w: AlertBookWatch) {
    try {
      this.o.store.saveAlertBooks(w);
      this.savedAt.set(key, this.o.now());
    } catch (error) {
      this.o.log?.(
        `alert books: saving ${w.symbol} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
