import type { AlpacaTrading, Order } from "./alpaca-trading.js";
import { finished } from "./ladder.js";
import { stopPrice } from "./options.js";
import { uncovered } from "./safety.js";

// Selling at the bid (user-confirmed 2026-10-10): a limit sell at the current
// bid, re-priced to the new bid every 5 seconds until it has all sold. The
// position's stop is taken off first, because the broker reserves the
// contracts for it, and put back on whatever is still held at the end.
//
// The account must never go short: every quantity sent is read fresh from the
// position, and a stop only ever covers contracts no other sell order does.

export type ExitClient = Pick<
  AlpacaTrading,
  | "position"
  | "openOrders"
  | "quote"
  | "sellLimit"
  | "replace"
  | "order"
  | "cancel"
  | "sellStop"
>;

export interface ExitOptions {
  intervalMs?: number; // between attempts
  maxMs?: number; // give up after this long and restore the stop
  stopPct?: number; // for a remainder that had no stop before
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface ExitResult {
  held: number; // before the sale
  entry: number; // average entry price
  asked: number;
  sold: number;
  price: number | null; // average sale price
  remaining: number;
  attempts: number; // prices tried
  timedOut: boolean; // not everything sold within maxMs
  // The stop on the contracts still held; null when none are.
  stop: { price: number; qty: number; error?: string } | null;
}

/** "all", "half" (rounded up) or a number of contracts. */
export function exitQty(wanted: string, held: number): number {
  const qty =
    wanted === "all"
      ? held
      : wanted === "half"
        ? Math.ceil(held / 2)
        : Number(wanted);
  if (!Number.isInteger(qty) || qty < 1 || qty > held)
    throw new Error(
      `Quantity must be all, half or a whole number from 1 to ${held}`,
    );
  return qty;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function sellAtBid(
  client: ExitClient,
  symbol: string,
  wanted: string,
  options: ExitOptions = {},
): Promise<ExitResult> {
  const interval = options.intervalMs ?? 5000;
  const maxMs = options.maxMs ?? 120000;
  const sleep =
    options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = options.log ?? (() => {});

  const before = await client.position(symbol);
  if (!(before.qty > 0)) throw new Error(`No long position in ${symbol}`);
  const asked = exitQty(wanted, before.qty);

  // Take the stops off; the lowest stop price is kept for the remainder.
  const open = (await client.openOrders(symbol)).filter(
    (o) => o.side === "sell",
  );
  const stops = open.filter((o) => o.stopPrice !== null);
  const working = open.filter((o) => o.stopPrice === null);
  if (working.length > 0)
    throw new Error(
      `${symbol} already has an open sell order; cancel it or wait for it`,
    );
  const oldStop =
    stops.length > 0 ? Math.min(...stops.map((o) => o.stopPrice!)) : null;
  for (const stop of stops) await client.cancel(stop.id);
  // Nothing is sold until the broker confirms the stops are gone: a stop and
  // a sale working together could sell the same contracts twice.
  let stopsGone = stops.length === 0;
  for (let i = 0; i < 10 && !stopsGone; i++) {
    await sleep(Math.min(interval, 1000));
    stopsGone = (await client.openOrders(symbol)).every(
      (o) => o.side !== "sell",
    );
  }
  if (stops.length > 0)
    log(
      stopsGone
        ? `stop taken off (${oldStop!.toFixed(2)})`
        : "the stop is still open; nothing will be sold",
    );

  let order: Order | null = null;
  let price: number | null = null;
  let attempts = 0;
  let waited = 0;
  let failure: unknown;
  try {
    while (stopsGone && waited <= maxMs) {
      if (order) {
        order = await client.order(order.id);
        if (finished.has(order.status)) break;
      }
      const bid = (await client.quote(symbol)).bid;
      if (bid > 0 && bid !== price) {
        try {
          order = order
            ? await client.replace(order.id, bid)
            : await client.sellLimit(
                symbol,
                // Never more than is held at this moment.
                Math.min(asked, (await client.position(symbol)).qty),
                bid,
              );
          price = bid;
          attempts++;
          log(`selling ${asked} @ ${bid.toFixed(2)} (the bid)`);
        } catch (error) {
          // Right after the stop is canceled the broker may still hold the
          // contracts; a re-price can also cross a fill. Try again next time.
          log(`could not sell @ ${bid.toFixed(2)}: ${message(error)}`);
        }
      }
      if (waited >= maxMs) break;
      await sleep(interval);
      waited += interval;
    }
    if (order && !finished.has(order.status)) {
      await client.cancel(order.id).catch(() => {});
      await sleep(Math.min(interval, 2000));
      order = await client.order(order.id);
    }
  } catch (error) {
    failure = error;
  }

  // Whatever happened above, the contracts still held get their stop back.
  let remaining = before.qty;
  try {
    remaining = (await client.position(symbol)).qty;
  } catch {
    remaining = 0; // the broker has no position left
  }
  let stop: ExitResult["stop"] = null;
  if (remaining > 0) {
    const at =
      oldStop ?? stopPrice(before.avgEntryPrice, options.stopPct ?? 40);
    // Only contracts that no open sell order still covers get the stop.
    const free = uncovered(remaining, symbol, await client.openOrders(symbol));
    stop = { price: at, qty: free };
    if (free < remaining && !stopsGone) {
      // The earlier stop never went away; it still protects the position.
    } else if (free < remaining) {
      stop.error = `a sell order is still open for ${remaining - free} contracts`;
    }
    if (free > 0)
      try {
        await client.sellStop(symbol, free, at);
        log(`stop ${at.toFixed(2)} back on ${free}`);
      } catch (error) {
        stop.error = message(error);
        log(`stop for ${free} failed: ${stop.error}`);
      }
  }
  if (failure) {
    log(`sale stopped: ${message(failure)}`);
    if (!order) throw failure;
  }
  if (!stopsGone)
    throw new Error(
      "The stop could not be taken off, so nothing was sold. Check the open orders.",
    );
  const sold = before.qty - remaining;
  return {
    held: before.qty,
    entry: before.avgEntryPrice,
    asked,
    sold,
    price: sold > 0 ? (order?.filledAvgPrice ?? price) : null,
    remaining,
    attempts,
    timedOut: sold < asked,
    stop,
  };
}
