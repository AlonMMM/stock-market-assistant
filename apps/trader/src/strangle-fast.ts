// The 60-second alert's data (packages/trading/src/strangle/fast.ts): 10-second
// bars built from SIP trades with Alpaca's own rules (trade-bars.ts, as
// scripts/build-10s-bars.ts built the backtest's database), today's polled
// every few seconds and the prior sessions' fetched once and kept.

import type { AlpacaTrade } from "../../../packages/market-data/src/alpaca.js";
import {
  TradeBarBuilder,
  type Trade,
  type TradeBar,
} from "../../../packages/market-data/src/trade-bars.js";
import {
  fastRule,
  type FastDay,
  type FastWindows,
} from "../../../packages/trading/src/strangle/fast.js";
import type { BotMarket } from "./bot.js";

export const toTrade = (t: AlpacaTrade): Trade => ({
  time: Date.parse(t.t), // nanoseconds are truncated to the millisecond
  price: t.p,
  size: t.s,
  conditions: t.c ?? [],
  tape: t.z ?? "",
  ...(t.u ? { correction: t.u } : {}),
});

/**
 * The stock's last trade each second from session second `from` to `to`
 * (09:30 New York = 0), by Alpaca's bar rules, as the backtest reads them
 * (volume-backtest.ts secondsFromTrades): only the seconds that traded.
 */
export async function stockSeconds(
  market: BotMarket,
  symbol: string,
  openMs: number,
  from: number,
  to: number,
): Promise<[number, number][]> {
  if (!market.trades) return [];
  const startMs = openMs + from * 1000;
  const endMs = openMs + (to + 1) * 1000;
  const builder = new TradeBarBuilder(1, startMs, endMs);
  await market.trades([symbol], startMs, endMs, (_, list) => {
    for (const t of list) builder.add(toTrade(t));
  });
  return builder
    .bars()
    .map((b) => [b.start - openMs / 1000, b.close] as [number, number]);
}

/** A session in 10-second slots from its bars. */
export function dayFromBars(
  bars: readonly TradeBar[],
  openMs: number,
): FastDay {
  const v: number[] = new Array(fastRule.slots).fill(0);
  const c: (number | null)[] = new Array(fastRule.slots).fill(null);
  for (const b of bars) {
    const t = Math.floor((b.start * 1000 - openMs) / 10_000);
    if (t < 0 || t >= fastRule.slots) continue;
    v[t] = b.volume;
    c[t] = b.close;
  }
  return { v, c };
}

/** Windows as stored: the moves to 10 significant digits. */
export const storedWindows = (w: FastWindows): FastWindows => ({
  vol: w.vol,
  move: w.move.map((x) => (x === null ? null : Number(x.toPrecision(10)))),
});

const chunk = <T>(list: T[], size: number) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, (i + 1) * size),
  );

// Trades reach the SIP a little late: each poll reads the last 10 seconds
// again and skips the trades it already has.
const overlapMs = 10_000;

/** Today's 10-second bars of the watched stocks, from their trades, polled. */
export class FastTape {
  private builders = new Map<string, TradeBarBuilder>();
  // Each stock's 1-second bars: the side's seconds since an alert.
  private secondBuilders = new Map<string, TradeBarBuilder>();
  private recent = new Set<string>();
  private recentAt: { key: string; ms: number }[] = [];
  /** Every trade before this time (Unix ms) is in. */
  cursor: number;
  constructor(
    readonly symbols: string[],
    readonly openMs: number,
    readonly endMs: number,
  ) {
    this.cursor = openMs;
  }

  private builder(symbol: string) {
    let b = this.builders.get(symbol);
    if (!b)
      this.builders.set(
        symbol,
        (b = new TradeBarBuilder(10, this.openMs, this.endMs)),
      );
    return b;
  }

  private secondBuilder(symbol: string) {
    let b = this.secondBuilders.get(symbol);
    if (!b)
      this.secondBuilders.set(
        symbol,
        (b = new TradeBarBuilder(1, this.openMs, this.endMs)),
      );
    return b;
  }

  /** Adds a trade once, whether it came from a poll or the stream. */
  add(symbol: string, t: AlpacaTrade) {
    const ms = Date.parse(t.t);
    if (!(ms >= this.openMs) || !(ms < this.endMs)) return;
    const key = `${symbol}|${t.x}|${t.i}|${ms}`;
    if (this.recent.has(key)) return;
    this.recent.add(key);
    this.recentAt.push({ key, ms });
    const trade = toTrade(t);
    this.builder(symbol).add(trade);
    this.secondBuilder(symbol).add(trade);
  }

  async poll(market: BotMarket, now: number): Promise<void> {
    if (!market.trades) return;
    const to = Math.min(now, this.endMs);
    const from = Math.max(this.openMs, this.cursor - overlapMs);
    if (to <= from) return;
    for (const part of chunk(this.symbols, 25))
      await market.trades(part, from, to, (symbol, list) => {
        for (const t of list) if (Date.parse(t.t) >= from) this.add(symbol, t);
      });
    this.reached(to);
  }

  /**
   * Every trade before `to` is in: by a poll, or by the stream that has run
   * since before then. Forgets the keys older than the next poll's overlap.
   */
  reached(to: number) {
    if (to > this.cursor) this.cursor = Math.min(to, this.endMs);
    const keep = this.cursor - overlapMs * 2;
    let drop = 0;
    while (drop < this.recentAt.length && this.recentAt[drop]!.ms < keep)
      this.recent.delete(this.recentAt[drop++]!.key);
    if (drop) this.recentAt.splice(0, drop);
  }

  /** Today's 10-second bars of one stock so far. */
  bars(symbol: string): readonly TradeBar[] {
    return this.builders.get(symbol)?.bars() ?? [];
  }

  /** The last whole session second the tape has every trade of. */
  covered(): number {
    return Math.floor((this.cursor - this.openMs) / 1000) - 1;
  }

  /**
   * The stock's last trade each second from session second `from` to `to`,
   * by Alpaca's bar rules (as stockSeconds), up to the seconds covered.
   */
  seconds(symbol: string, from: number, to: number): [number, number][] {
    const open = this.openMs / 1000;
    const hi = open + Math.min(to, this.covered());
    return (this.secondBuilders.get(symbol)?.bars() ?? [])
      .filter((b) => b.start >= open + from && b.start <= hi)
      .map((b) => [b.start - open, b.close] as [number, number]);
  }

  day(symbol: string): FastDay {
    return dayFromBars(this.builders.get(symbol)?.bars() ?? [], this.openMs);
  }
}

/**
 * The 10-second slots to read now, in order, after `done`: every one at
 * least 3 s old (`ready`), then the newer whole ones (`early`) while each
 * fires; a quiet one waits for its late prints, which can only add volume.
 */
export function slotsToRead(
  done: number,
  early: number,
  ready: number,
  fires: (t: number) => boolean,
): number[] {
  const out: number[] = [];
  for (let t = done + 1; t <= early; t++) {
    if (t > ready && !fires(t)) break;
    out.push(t);
  }
  return out;
}

/** A whole past session of one stock in 10-second bars; null without trades. */
export async function fetchFastBars(
  market: BotMarket,
  symbol: string,
  openMs: number,
  endMs: number,
): Promise<FastDay | null> {
  if (!market.trades) return null;
  const builder = new TradeBarBuilder(10, openMs, endMs);
  let n = 0;
  await market.trades([symbol], openMs, endMs, (_, list) => {
    n += list.length;
    for (const t of list) builder.add(toTrade(t));
  });
  if (!n) return null;
  return dayFromBars(builder.bars(), openMs);
}

/** A whole past session of one stock, as windows and its bars; null without trades. */
export async function fetchFastDay(
  market: BotMarket,
  symbol: string,
  openMs: number,
  endMs: number,
  windows: (day: FastDay) => FastWindows,
): Promise<{ windows: FastWindows; bars: FastDay } | null> {
  const bars = await fetchFastBars(market, symbol, openMs, endMs);
  if (!bars) return null;
  return { windows: storedWindows(windows(bars)), bars };
}
