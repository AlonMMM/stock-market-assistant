import {
  coreClose,
  newYork,
} from "../../../packages/market-data/src/calendar.js";
import type { OptionQuote } from "../../../packages/trading/src/options.js";
import type { PriceTick, RecorderStore } from "./recorder-store.js";

// Every second of regular hours (user 2026-10-28): each position a bot holds,
// with the stock's last trade and the contract's bid / ask, and each stock the
// volume bot watches from its alert to the side, with the call and put it
// would pick quoted every 5 seconds. The bots read the same prices to decide;
// this writes them down for the Review page's replays.

export interface HeldTarget {
  kind: "held";
  bot: "main" | "volume";
  ref: string;
  symbol: string;
  contract: string;
  quote: (contract: string) => Promise<OptionQuote>;
}

export interface WatchTarget {
  kind: "watch";
  bot: "volume";
  ref: string;
  symbol: string;
  // The 0.35-delta call and put of the trade's expiry, picked once a watch.
  legs: () => Promise<{ call: string | null; put: string | null }>;
  quote: (contract: string) => Promise<OptionQuote>;
}

export type RecordTarget = HeldTarget | WatchTarget;

export interface PriceRecorderOptions {
  store: Pick<RecorderStore, "addTicks">;
  targets: () => RecordTarget[];
  lastPrices: (symbols: string[]) => Promise<Map<string, number>>;
  now?: () => number;
  log?: (line: string) => void;
}

export const legsEveryMs = 5_000;
const legsRetryMs = 30_000;

type Book = { bid: number | null; ask: number | null };
const noBook: Book = { bid: null, ask: null };

export class PriceRecorder {
  private busy = false;
  private legs = new Map<
    string,
    { call: string | null; put: string | null } | { failedAt: number }
  >();
  private legsAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly o: PriceRecorderOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
  }

  /** Regular hours of a session, New York. */
  private open(at: number): boolean {
    const { date, minute } = newYork(at);
    const close = coreClose(date);
    return close !== null && minute >= 570 && minute < close;
  }

  private async book(
    quote: (c: string) => Promise<OptionQuote>,
    contract: string | null,
  ): Promise<Book> {
    if (!contract) return noBook;
    try {
      const q = await quote(contract);
      const ok = Number.isFinite(q.bid) && Number.isFinite(q.ask);
      return ok ? { bid: q.bid, ask: q.ask } : noBook;
    } catch {
      return noBook;
    }
  }

  private async legsOf(t: WatchTarget, at: number) {
    const got = this.legs.get(t.ref);
    if (got && !("failedAt" in got)) return got;
    if (got && at - got.failedAt < legsRetryMs) return null;
    try {
      const legs = await t.legs();
      this.legs.set(t.ref, legs);
      return legs;
    } catch {
      this.legs.set(t.ref, { failedAt: at });
      return null;
    }
  }

  /** Called every second; one row per target. */
  async tick(): Promise<void> {
    if (this.busy) return;
    const at = this.now();
    if (!this.open(at)) return;
    this.busy = true;
    try {
      const targets = this.o.targets();
      // Forget the watches and positions that ended.
      const live = new Set(targets.map((t) => t.ref));
      for (const ref of this.legs.keys())
        if (!live.has(ref)) this.legs.delete(ref);
      for (const ref of this.legsAt.keys())
        if (!live.has(ref)) this.legsAt.delete(ref);
      if (!targets.length) return;
      let prices = new Map<string, number>();
      try {
        prices = await this.o.lastPrices([
          ...new Set(targets.map((t) => t.symbol)),
        ]);
      } catch {
        // the rows still carry the option books
      }
      const rows = await Promise.all(
        targets.map((t) => this.row(t, at, prices.get(t.symbol) ?? null)),
      );
      this.o.store.addTicks(rows);
    } catch (error) {
      this.log(
        `price record failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.busy = false;
    }
  }

  private async row(
    t: RecordTarget,
    at: number,
    stock: number | null,
  ): Promise<PriceTick> {
    const base = {
      at,
      bot: t.bot,
      ref: t.ref,
      symbol: t.symbol,
      stock,
      contract: null,
      bid: null,
      ask: null,
      call: null,
      callBid: null,
      callAsk: null,
      put: null,
      putBid: null,
      putAsk: null,
    };
    if (t.kind === "held") {
      const b = await this.book(t.quote, t.contract);
      return { ...base, phase: "held", contract: t.contract, ...b };
    }
    const legs = await this.legsOf(t, at);
    const last = this.legsAt.get(t.ref) ?? 0;
    if (!legs || at - last < legsEveryMs)
      return {
        ...base,
        phase: "watch",
        call: legs?.call ?? null,
        put: legs?.put ?? null,
      };
    this.legsAt.set(t.ref, at);
    const [c, p] = await Promise.all([
      this.book(t.quote, legs.call),
      this.book(t.quote, legs.put),
    ]);
    return {
      ...base,
      phase: "watch",
      call: legs.call,
      callBid: c.bid,
      callAsk: c.ask,
      put: legs.put,
      putBid: p.bid,
      putAsk: p.ask,
    };
  }
}
