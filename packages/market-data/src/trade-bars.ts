// Bars built from individual trades, for bar sizes Alpaca does not serve
// (anything under a minute). The rules follow Alpaca's "How are bars
// aggregated?" (docs.alpaca.markets/docs/market-data-faq, read 2026-10-23) so a
// minute rolled up from these bars matches Alpaca's own minute bar: a trade's
// condition codes decide whether it updates the prices, the volume, or neither.

export interface Trade {
  time: number; // execution time, Unix milliseconds
  price: number;
  size: number; // shares
  conditions: string[]; // SIP condition codes, e.g. ["@", "I"]
  tape: string; // "A" | "B" (CTA) | "C" (UTP); anything else gets both rule sets
  correction?: string; // Alpaca `u`: "canceled" | "incorrect" | "corrected"
}

export interface TradeBar {
  start: number; // bar start, Unix seconds, a multiple of the bar size
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // shares, from every volume-counted trade (odd lots included)
  trades: number; // volume-counted trades in the bar
  vwap: number; // volume-weighted price over the volume-counted trades
}

// Intraday ("minute") rules. T (Form T / extended hours) is excluded only
// from daily bars, so it is not here. CTA codes B and UTP code W are both
// "average price trade".
const noPriceCta = new Set("BCHIMNPQRUVZ479");
const noPriceUtp = new Set("CGHIMNPQRUVWZ479");
const noVolume = new Set("MQ9");

/** Which bar fields a trade updates, per its tape and condition codes. */
export function tradeRole(
  trade: Pick<Trade, "conditions" | "tape" | "correction">,
): {
  price: boolean;
  volume: boolean;
} {
  // A canceled print, or one later replaced by a correction, never counts.
  if (trade.correction === "canceled" || trade.correction === "incorrect")
    return { price: false, volume: false };
  const isCta = trade.tape === "A" || trade.tape === "B";
  const isUtp = trade.tape === "C";
  let price = true;
  let volume = true;
  for (const code of trade.conditions) {
    if (noVolume.has(code)) volume = false;
    const excludedByCta = noPriceCta.has(code);
    const excludedByUtp = noPriceUtp.has(code);
    if (isCta && excludedByCta) price = false;
    else if (isUtp && excludedByUtp) price = false;
    else if (!isCta && !isUtp && (excludedByCta || excludedByUtp))
      price = false;
  }
  return { price, volume };
}

interface Accumulator {
  open?: number;
  high: number;
  low: number;
  close?: number;
  volume: number;
  trades: number;
  notional: number;
}

/**
 * Collects trades into fixed-size bars inside [startMs, endMs). Trades may
 * arrive in any order; `bars()` returns the finished bars sorted by start. A
 * bar is only emitted when at least one trade set its prices and its volume
 * is above zero, as Alpaca does (a lone odd lot makes no bar).
 */
export class TradeBarBuilder {
  private buckets = new Map<number, Accumulator>();
  private lastPriceTime = new Map<number, number>();
  private firstPriceTime = new Map<number, number>();
  constructor(
    private barSeconds: number,
    private startMs: number,
    private endMs: number,
  ) {
    if (!Number.isInteger(barSeconds) || barSeconds <= 0)
      throw new Error("Bar size must be a positive number of seconds");
  }

  add(trade: Trade) {
    if (trade.time < this.startMs || trade.time >= this.endMs) return;
    if (!(trade.price > 0) || !(trade.size > 0)) return;
    const role = tradeRole(trade);
    if (!role.price && !role.volume) return;
    const start =
      Math.floor(trade.time / 1000 / this.barSeconds) * this.barSeconds;
    let bucket = this.buckets.get(start);
    if (!bucket) {
      bucket = {
        high: -Infinity,
        low: Infinity,
        volume: 0,
        trades: 0,
        notional: 0,
      };
      this.buckets.set(start, bucket);
    }
    if (role.volume) {
      bucket.volume += trade.size;
      bucket.trades += 1;
      bucket.notional += trade.price * trade.size;
    }
    if (role.price) {
      // Open is the earliest price-setting trade, close the latest, so pages
      // arriving out of order still give the right ends.
      const first = this.firstPriceTime.get(start);
      if (first === undefined || trade.time < first) {
        this.firstPriceTime.set(start, trade.time);
        bucket.open = trade.price;
      }
      const last = this.lastPriceTime.get(start);
      if (last === undefined || trade.time >= last) {
        this.lastPriceTime.set(start, trade.time);
        bucket.close = trade.price;
      }
      if (trade.price > bucket.high) bucket.high = trade.price;
      if (trade.price < bucket.low) bucket.low = trade.price;
    }
  }

  bars(): TradeBar[] {
    const result: TradeBar[] = [];
    for (const [start, b] of this.buckets) {
      if (b.open === undefined || b.close === undefined || b.volume <= 0)
        continue;
      result.push({
        start,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        trades: b.trades,
        vwap: b.notional / b.volume,
      });
    }
    return result.sort((a, b) => a.start - b.start);
  }
}

/** Rolls bars up to a larger size (e.g. 10 s → 60 s), for checks against a provider. */
export function rollUp(bars: TradeBar[], toSeconds: number): TradeBar[] {
  const groups = new Map<number, TradeBar[]>();
  for (const bar of bars) {
    const start = Math.floor(bar.start / toSeconds) * toSeconds;
    const group = groups.get(start);
    if (group) group.push(bar);
    else groups.set(start, [bar]);
  }
  return [...groups]
    .map(([start, parts]) => {
      parts.sort((a, b) => a.start - b.start);
      const volume = parts.reduce((sum, p) => sum + p.volume, 0);
      return {
        start,
        open: parts[0]!.open,
        high: Math.max(...parts.map((p) => p.high)),
        low: Math.min(...parts.map((p) => p.low)),
        close: parts.at(-1)!.close,
        volume,
        trades: parts.reduce((sum, p) => sum + p.trades, 0),
        vwap: parts.reduce((sum, p) => sum + p.vwap * p.volume, 0) / volume,
      };
    })
    .sort((a, b) => a.start - b.start);
}
