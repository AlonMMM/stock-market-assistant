import { useEffect, useRef, useState } from "react";
import type { Board } from "../../../packages/market-data/src/board.js";
import type { LatestPrices } from "../../../packages/market-data/src/latest-prices.js";
import { boardTrading, livePriceMs } from "./live-model.js";

export type LivePriceState = "live" | "waiting" | "off" | "unavailable";

/**
 * The latest trade of every symbol on the board, read every second while the
 * page is visible and the board's session is trading. One request at a time;
 * a failed read is tried again a second later. "unavailable": the server has
 * no real-time SIP data, so it stops asking.
 */
export function useLivePrices(board: Board | null) {
  const [prices, setPrices] = useState<LatestPrices["prices"]>({});
  const [state, setState] = useState<LivePriceState>("waiting");
  const unavailable = useRef(false);
  const symbols = board ? board.series.map((s) => s.ticker).join(",") : "";
  const boardRef = useRef(board);
  boardRef.current = board;
  useEffect(() => {
    if (!symbols || unavailable.current) return;
    let active = true;
    let reading = false;
    const read = async () => {
      const current = boardRef.current;
      if (reading || document.visibilityState !== "visible" || !current) return;
      if (!boardTrading(current)) {
        setState("off");
        return;
      }
      reading = true;
      try {
        const response = await fetch(
          `/api/prices?${new URLSearchParams({ symbols })}`,
          { signal: AbortSignal.timeout(4000) },
        );
        if (!active) return;
        if (response.status === 409) {
          unavailable.current = true;
          setState("unavailable");
          clearInterval(timer);
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as LatestPrices;
        if (!active) return;
        // Merged, so a symbol missing from one answer keeps its last price.
        setPrices((before) => ({ ...before, ...body.prices }));
        setState("live");
      } catch {
        if (active) setState("waiting");
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), livePriceMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [symbols]);
  return { prices, state };
}
