import {
  coreClose,
  newYork,
} from "../../../packages/market-data/src/calendar.js";
import type { OptionQuote } from "../../../packages/trading/src/options.js";
import {
  expiryWindow,
  type PickRules,
} from "../../../packages/trading/src/bot/picker.js";
import {
  dueAt,
  sampleSide,
} from "../../../packages/trading/src/bot/quote-sample.js";
import type { BotStore, QuoteSample } from "./bot-store.js";

// Samples the option books the Main bot would trade (docs/tasks/backend-indi-bot.md,
// "Quote samples"): each watched stock every 15 minutes, 09:40–15:55 New York;
// per side the bot's pick and the next strike in and out, with bid, ask, open
// interest and 30-minute volume. Market data only: no orders. It has its own
// timer, so a slow read never delays the bot's exit checks; a failure only
// skips that stock.

export interface QuoteSamplerOptions {
  store: BotStore;
  chain(
    underlying: string,
    right: "call" | "put",
    from: string,
    to: string,
  ): Promise<OptionQuote[]>;
  volumes30(
    contracts: string[],
    date: string,
    minute: number,
  ): Promise<Map<string, number>>;
  symbols(): string[];
  spot(symbol: string): number | null;
  rules(): PickRules;
  now(): number;
  log?: (line: string) => void;
}

export const sampleEveryMinutes = 15;
const firstMinute = 10; // 09:40
const lastMinute = 385; // 15:55

export class QuoteSampler {
  private busy = false;
  private doneMinute = -1;
  private doneDay = "";
  constructor(private o: QuoteSamplerOptions) {}

  /** Called every minute or so; samples the stocks due at this minute once. */
  async tick(): Promise<void> {
    if (this.busy) return;
    const { date, minute: wall } = newYork(this.o.now());
    const close = coreClose(date);
    if (close === null) return;
    const m = wall - 570;
    if (m < firstMinute || m > Math.min(lastMinute, close - 570 - 5)) return;
    if (date === this.doneDay && m <= this.doneMinute) return;
    this.busy = true;
    try {
      this.doneDay = date;
      this.doneMinute = m;
      for (const symbol of dueAt(this.o.symbols(), m, sampleEveryMinutes))
        await this.sample(date, m, symbol).catch((error) =>
          this.o.log?.(
            `quote sample ${symbol} failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    } finally {
      this.busy = false;
    }
  }

  private async sample(date: string, m: number, symbol: string) {
    const spot = this.o.spot(symbol);
    if (spot === null) return;
    const rules = this.o.rules();
    const [from, to] = expiryWindow(date, rules);
    const picked: {
      right: "C" | "P";
      slot: QuoteSample["slot"];
      quote: OptionQuote;
      at: number;
    }[] = [];
    for (const side of ["call", "put"] as const) {
      const quotes = await this.o.chain(symbol, side, from, to);
      const at = this.o.now();
      for (const x of sampleSide(quotes, spot, side, date, rules))
        picked.push({ right: side === "call" ? "C" : "P", ...x, at });
    }
    if (picked.length === 0) return;
    const volumes = await this.o
      .volumes30(
        picked.map((p) => p.quote.symbol),
        date,
        m,
      )
      .catch(() => null);
    this.o.store.addQuoteSamples(
      picked.map(({ right, slot, quote: q, at }) => ({
        day: date,
        minute: m,
        at,
        symbol,
        spot,
        right,
        slot,
        contract: q.symbol,
        expiry: q.expiry,
        strike: q.strike,
        delta: q.delta,
        bid: q.bid,
        ask: q.ask,
        ...(q.quotedAt === undefined ? {} : { quotedAt: q.quotedAt }),
        volume30: volumes?.get(q.symbol) ?? null,
        openInterest: q.openInterest ?? null,
      })),
    );
  }
}
