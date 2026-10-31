import type { OptionQuote } from "../../../packages/trading/src/options.js";
import type { BotTrading } from "./bot.js";
import type { StrangleStore } from "./strangle-store.js";

// The option books around every Volume bot alert, traded or not (user
// 2026-10-31: "save every 2 second around the alert + delta 0.1 to 0.35";
// "you can go with +300s, as for the plan you can go with minute check"), so
// its backtest can fill at the real bid and ask instead of a model. At the
// alert the calls and puts of the bot's expiry with |delta| 0.10-0.35 are
// fixed; their bid and ask are then read every 2 seconds for 300 seconds (the
// side and the buy), then once a minute until the bot's last sale minute (the
// give-back exit, checked on minute closes). Reads are batched: one request
// for up to 100 contracts. A watch is written every 30 seconds and at each
// minute read, so a restart loses at most that much.

export const bookWatch = {
  deltaMin: 0.1,
  deltaMax: 0.35,
  everyMs: 2_000,
  fineMs: 300_000,
  minuteMs: 60_000,
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
  endAt: number; // ms: the bot's last sale minute
  // Fixed at the alert: OCC symbols and their delta then.
  contracts: { symbol: string; delta: number }[];
  // Each sample: when it was read (ms) and per contract [bid, ask], null when
  // there was no quote for it. Every 2 s for 300 s, then once a minute.
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

const chunk = <T>(list: T[], size: number) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, (i + 1) * size),
  );

export class AlertBooks {
  private watches = new Map<string, AlertBookWatch>();
  private savedAt = new Map<string, number>();
  private busy = false;
  constructor(
    private readonly o: {
      chain: BotTrading["chain"];
      // Many contracts at once; absent: the chain of each watch's expiry.
      quotes?: (contracts: string[]) => Promise<OptionQuote[]>;
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
    endAt: number;
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

  /** Whether a watch reads now: every 2 s in its first 300 s, then on each new minute. */
  private due(w: AlertBookWatch, now: number): boolean {
    if (now - w.startedAt < bookWatch.fineMs) return true;
    const last = w.samples.at(-1)?.at ?? 0;
    return (
      Math.floor(now / bookWatch.minuteMs) >
      Math.floor(last / bookWatch.minuteMs)
    );
  }

  /** Every 2 seconds: the watches due now, in batched reads; ends the finished ones. */
  async step(): Promise<void> {
    if (this.busy || !this.watches.size) return;
    this.busy = true;
    try {
      const now = this.o.now();
      const reading = [...this.watches].filter(
        ([, w]) => now < w.endAt && this.due(w, now),
      );
      const quotes = await this.read(reading.map(([, w]) => w));
      for (const [key, w] of reading) {
        this.sample(w, quotes);
        const fine = now - w.startedAt < bookWatch.fineMs;
        const saved = this.savedAt.get(key) ?? 0;
        if (!fine || now - saved >= bookWatch.saveEveryMs) this.save(key, w);
      }
      for (const [key, w] of this.watches) {
        if (now < w.endAt) continue;
        this.save(key, w);
        this.watches.delete(key);
        this.savedAt.delete(key);
      }
    } finally {
      this.busy = false;
    }
  }

  /** The quotes of the watches' contracts; a failed read is a gap. */
  private async read(watches: AlertBookWatch[]): Promise<OptionQuote[]> {
    if (!watches.length) return [];
    const quotes = this.o.quotes;
    if (quotes) {
      const wanted = [
        ...new Set(watches.flatMap((w) => w.contracts.map((c) => c.symbol))),
      ];
      const parts = await Promise.all(
        chunk(wanted, 100).map((part) => quotes(part).catch(() => [])),
      );
      return parts.flat();
    }
    const parts = await Promise.all(
      watches.flatMap((w) =>
        (["call", "put"] as const).map((right) =>
          this.o.chain(w.symbol, right, w.expiry, w.expiry).catch(() => []),
        ),
      ),
    );
    return parts.flat();
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
