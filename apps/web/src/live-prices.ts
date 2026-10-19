import { useEffect, useRef, useState } from "react";
import type { Board } from "../../../packages/market-data/src/board.js";
import type { LatestPrices } from "../../../packages/market-data/src/latest-prices.js";
import { advance, type Running, type Trade } from "./chart-live.js";
import { boardTrading, livePriceMs } from "./live-model.js";

export type LivePriceState = "live" | "waiting" | "off" | "unavailable";

// Set once the server says it has no real-time SIP: no page asks again.
let unavailable = false;

// Every chart and the board share one request per second: the union of the
// symbols of those whose session is trading.
interface Subscriber {
  symbols: string[];
  trading: () => boolean;
  update: (
    prices: LatestPrices["prices"] | null,
    state: LivePriceState,
  ) => void;
}
const subscribers = new Set<Subscriber>();
let timer: ReturnType<typeof setInterval> | undefined;
let reading = false;

async function tick() {
  if (reading || document.visibilityState !== "visible") return;
  const active = [...subscribers].filter((s) => {
    const on = s.trading();
    if (!on) s.update(null, "off");
    return on;
  });
  const symbols = [...new Set(active.flatMap((s) => s.symbols))];
  if (symbols.length === 0) return;
  reading = true;
  try {
    const response = await fetch(
      `/api/prices?${new URLSearchParams({ symbols: symbols.join(",") })}`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (response.status === 409) {
      unavailable = true;
      clearInterval(timer);
      timer = undefined;
      for (const s of subscribers) s.update(null, "unavailable");
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as LatestPrices;
    for (const s of active) s.update(body.prices, "live");
  } catch {
    for (const s of active) s.update(null, "waiting");
  } finally {
    reading = false;
  }
}

/**
 * The latest trade of each symbol, read every second while the page is
 * visible and `trading()` holds. One request at a time for all subscribers;
 * a failed read is tried again a second later. "unavailable": the server has
 * no real-time SIP data, so nothing asks again until the page is reloaded.
 */
export function useLatestPrices(symbols: string[], trading: () => boolean) {
  const [prices, setPrices] = useState<LatestPrices["prices"]>({});
  const [state, setState] = useState<LivePriceState>(
    unavailable ? "unavailable" : "waiting",
  );
  const key = [...new Set(symbols)].join(",");
  const tradingRef = useRef(trading);
  tradingRef.current = trading;
  useEffect(() => {
    if (!key || unavailable) return;
    const mine = key.split(",");
    const subscriber: Subscriber = {
      symbols: mine,
      trading: () => tradingRef.current(),
      update: (next, nextState) => {
        setState(nextState);
        if (!next) return;
        const own = Object.fromEntries(
          Object.entries(next).filter(([symbol]) => mine.includes(symbol)),
        );
        // Merged, so a symbol missing from one answer keeps its last price.
        setPrices((before) => ({ ...before, ...own }));
      },
    };
    subscribers.add(subscriber);
    timer ??= setInterval(() => void tick(), livePriceMs);
    void tick();
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  }, [key]);
  return { prices, state };
}

/** Every symbol on the board, while the board's session is trading. */
export function useLivePrices(board: Board | null) {
  const boardRef = useRef(board);
  boardRef.current = board;
  return useLatestPrices(board ? board.series.map((s) => s.ticker) : [], () =>
    boardRef.current ? boardTrading(boardRef.current) : false,
  );
}

/**
 * The bar the latest trades are forming (chart-live.ts `advance`), kept
 * between reads of the chart; it starts over when `key` changes (another
 * stock, date or bar size). `slot` gives a trade's bar start, or null for a
 * trade the chart does not show.
 */
export function useRunningBar(
  trade: Trade | undefined,
  slot: (at: number) => number | null,
  key: string,
): Running | null {
  const [state, setState] = useState<{ key: string; run: Running | null }>({
    key,
    run: null,
  });
  const slotRef = useRef(slot);
  slotRef.current = slot;
  useEffect(() => {
    if (!trade) return;
    const start = slotRef.current(trade.at);
    if (start === null) return;
    setState((s) => ({
      key,
      run: advance(s.key === key ? s.run : null, trade, start),
    }));
  }, [trade, key]);
  return state.key === key ? state.run : null;
}
