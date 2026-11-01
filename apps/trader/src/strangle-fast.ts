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

  async poll(market: BotMarket, now: number): Promise<void> {
    if (!market.trades) return;
    const to = Math.min(now, this.endMs);
    const from = Math.max(this.openMs, this.cursor - overlapMs);
    if (to <= from) return;
    const keep = to - overlapMs;
    for (const part of chunk(this.symbols, 25))
      await market.trades(part, from, to, (symbol, list) => {
        const builder = this.builder(symbol);
        for (const t of list) {
          const ms = Date.parse(t.t);
          if (!(ms >= from)) continue;
          const key = `${symbol}|${t.x}|${t.i}|${t.t}`;
          if (this.recent.has(key)) continue;
          if (ms >= keep) {
            this.recent.add(key);
            this.recentAt.push({ key, ms });
          }
          builder.add(toTrade(t));
        }
      });
    this.cursor = to;
    // Forget the keys older than the next poll's overlap.
    let drop = 0;
    while (drop < this.recentAt.length && this.recentAt[drop]!.ms < keep)
      this.recent.delete(this.recentAt[drop++]!.key);
    if (drop) this.recentAt.splice(0, drop);
  }

  day(symbol: string): FastDay {
    return dayFromBars(this.builders.get(symbol)?.bars() ?? [], this.openMs);
  }
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
