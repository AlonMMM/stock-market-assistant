import type { AlpacaTrading, Order } from "./alpaca-trading.js";
import { finished } from "./ladder.js";
import { stopPrice } from "./options.js";

// After the price raises: watch the buy order for a short time, keep a stop
// on every contract that fills, then cancel what did not fill. Nothing is left
// working that could fill later without a stop.

export type ProtectClient = Pick<
  AlpacaTrading,
  "order" | "sellStop" | "replaceStop" | "cancel"
>;

export interface ProtectOptions {
  waitMs?: number; // how long an unfilled order is watched
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface ProtectResult {
  order: Order; // the buy order's final state
  canceledQty: number; // contracts withdrawn because they did not fill in time
  cancelError?: string; // the broker refused the cancel: they may still fill
  stop: {
    pct: number;
    price?: number; // set once a stop order is in place
    qty?: number; // contracts it covers
    error?: string; // the last attempt to place or enlarge it failed
  };
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function protectFill(
  client: ProtectClient,
  buy: Order,
  stopPct: number,
  options: ProtectOptions = {},
): Promise<ProtectResult> {
  const waitMs = options.waitMs ?? 120000;
  const pollMs = options.pollMs ?? 3000;
  const sleep =
    options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = options.log ?? (() => {});
  let order = buy;
  let placed: { id: string; qty: number; price: number } | null = null;
  let stopError: string | undefined;

  // One stop for everything filled so far, priced from the average fill.
  const cover = async () => {
    if (!(order.filledQty > 0) || !order.filledAvgPrice) return;
    const price = stopPrice(order.filledAvgPrice, stopPct);
    if (placed && placed.qty === order.filledQty && placed.price === price)
      return;
    try {
      const sent = placed
        ? await client.replaceStop(placed.id, order.filledQty, price)
        : await client.sellStop(order.symbol, order.filledQty, price);
      placed = { id: sent.id, qty: order.filledQty, price };
      stopError = undefined;
      log(`stop ${price.toFixed(2)} covers ${order.filledQty}`);
    } catch (error) {
      stopError = message(error);
      log(`stop for ${order.filledQty} failed: ${stopError}`);
    }
  };

  await cover();
  for (
    let waited = 0;
    !finished.has(order.status) && waited < waitMs;
    waited += pollMs
  ) {
    await sleep(pollMs);
    const before = order.filledQty;
    order = await client.order(order.id);
    if (order.filledQty !== before) await cover();
  }

  let canceledQty = 0;
  let cancelError: string | undefined;
  if (!finished.has(order.status)) {
    try {
      await client.cancel(order.id);
      log(`canceled the unfilled part after ${Math.round(waitMs / 1000)} s`);
    } catch (error) {
      cancelError = message(error);
      log(`cancel failed: ${cancelError}`);
    }
    // A fill can arrive while the cancel is on its way.
    await sleep(pollMs);
    order = await client.order(order.id);
    if (!cancelError) canceledQty = order.qty - order.filledQty;
  }
  // Also retries a stop the broker refused while the buy was still open.
  await cover();
  const stop = placed as { qty: number; price: number } | null;
  return {
    order,
    canceledQty,
    ...(cancelError ? { cancelError } : {}),
    stop: {
      pct: stopPct,
      ...(stop ? { price: stop.price, qty: stop.qty } : {}),
      ...(stopError ? { error: stopError } : {}),
    },
  };
}
