// Latest trade prices for the Watchlist (user 2026-10-19: "I want the
// watchlist to be updated every 1 second"). The board keeps its 5-minute bars
// and volume numbers; the page reads these prices every second and applies
// them on top, so Last, Change % and the day line move with each trade.
import type { Credentials } from "./backtest.js";
import { tickerPattern } from "./backtest.js";
import { defaultSipDelayMinutes } from "./sip-delay.js";

// A board shows at most 200 symbols, plus SPY, QQQ and sector ETFs.
export const maxPriceSymbols = 250;

export interface LatestPrices {
  // Symbol → last trade price and its time (Unix ms). A symbol without a
  // trade (or one Alpaca does not know) is left out.
  prices: Record<string, { price: number; at: number }>;
}

type Answer = { status: number; body: LatestPrices | { error: string } };

/** `GET /api/prices?symbols=AAPL,MSFT`: one Alpaca request for all of them. */
export async function handleLatestPrices(
  symbolsParam: string | null,
  credentials: Credentials,
  fetcher: typeof fetch = fetch,
  restUrl = "https://data.alpaca.markets",
): Promise<Answer> {
  if (!credentials.key || !credentials.secret)
    return {
      status: 503,
      body: { error: "Alpaca credentials are not configured on the server" },
    };
  // Without real-time SIP the latest trade is not available; the page keeps
  // the board's prices and stops asking.
  if ((credentials.sipDelayMinutes ?? defaultSipDelayMinutes) > 0)
    return {
      status: 409,
      body: { error: "Live prices need real-time SIP data" },
    };
  const symbols = [
    ...new Set(
      (symbolsParam ?? "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (symbols.length === 0)
    return { status: 400, body: { error: "symbols is required" } };
  if (symbols.length > maxPriceSymbols)
    return {
      status: 400,
      body: { error: `At most ${maxPriceSymbols} symbols` },
    };
  const invalid = symbols.filter((s) => !tickerPattern.test(s));
  if (invalid.length)
    return {
      status: 400,
      body: { error: `Not US symbols: ${invalid.join(", ")}` },
    };
  const url = new URL("/v2/stocks/trades/latest", restUrl);
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("feed", "sip");
  let response: Response;
  try {
    // Workers reject fetch invoked with a foreign `this` ("Illegal invocation").
    response = await fetcher.call(globalThis, url, {
      headers: {
        "APCA-API-KEY-ID": credentials.key,
        "APCA-API-SECRET-KEY": credentials.secret,
      },
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    return {
      status: 502,
      body: {
        error: `Alpaca latest trades failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (!response.ok)
    return {
      status: 502,
      body: { error: `Alpaca latest trades failed (HTTP ${response.status})` },
    };
  const body = (await response.json()) as {
    trades?: Record<string, { t?: unknown; p?: unknown } | null> | null;
  };
  const prices: LatestPrices["prices"] = {};
  for (const [symbol, trade] of Object.entries(body.trades ?? {})) {
    const at = typeof trade?.t === "string" ? Date.parse(trade.t) : NaN;
    if (
      symbols.includes(symbol) &&
      typeof trade?.p === "number" &&
      trade.p > 0 &&
      Number.isFinite(at)
    )
      prices[symbol] = { price: trade.p, at };
  }
  return { status: 200, body: { prices } };
}
