import { parseOccSymbol, type OptionQuote, type Right } from "./options.js";

type Fetcher = typeof fetch;

export const paperUrl = "https://paper-api.alpaca.markets";
export const liveUrl = "https://api.alpaca.markets";

export interface Order {
  id: string;
  symbol: string;
  status: string;
  qty: number;
  filledQty: number;
  filledAvgPrice: number | null;
  limitPrice: number | null;
}

interface Snapshot {
  latestQuote?: { bp?: number; ap?: number };
  greeks?: { delta?: number } | null;
}

interface RawOrder {
  id: string;
  symbol: string;
  status: string;
  qty: string | null;
  filled_qty: string;
  filled_avg_price: string | null;
  limit_price: string | null;
}

const order = (raw: RawOrder): Order => ({
  id: raw.id,
  symbol: raw.symbol,
  status: raw.status,
  qty: Number(raw.qty ?? 0),
  filledQty: Number(raw.filled_qty),
  filledAvgPrice:
    raw.filled_avg_price === null ? null : Number(raw.filled_avg_price),
  limitPrice: raw.limit_price === null ? null : Number(raw.limit_price),
});

function quote(symbol: string, s: Snapshot): OptionQuote {
  const parsed = parseOccSymbol(symbol);
  const delta = s.greeks?.delta;
  return {
    symbol,
    ...parsed,
    bid: s.latestQuote?.bp ?? 0,
    ask: s.latestQuote?.ap ?? 0,
    delta: typeof delta === "number" && Number.isFinite(delta) ? delta : null,
  };
}

// Alpaca Trading API (account and orders) plus option snapshots from the
// Market Data API. Paper trading unless the caller passes liveUrl.
export class AlpacaTrading {
  constructor(
    private key: string,
    private secret: string,
    private tradingUrl = paperUrl,
    private feed: "opra" | "indicative" = "opra",
    private fetcher: Fetcher = fetch,
    private dataUrl = "https://data.alpaca.markets",
  ) {}

  private async call<T>(
    base: string,
    path: string,
    init: {
      method?: string;
      body?: unknown;
      query?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(init.query ?? {}))
      url.searchParams.set(k, v);
    const response = await this.fetcher.call(globalThis, url, {
      method: init.method ?? "GET",
      headers: {
        "APCA-API-KEY-ID": this.key,
        "APCA-API-SECRET-KEY": this.secret,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `Alpaca ${init.method ?? "GET"} ${url.pathname} failed (${response.status}): ${text.slice(0, 300)}`,
      );
    return (text ? JSON.parse(text) : null) as T;
  }

  async equity(): Promise<number> {
    const account = await this.call<{ equity: string }>(
      this.tradingUrl,
      "/v2/account",
    );
    return Number(account.equity);
  }

  /** Quotes and deltas for one side of the chain, expiries in [from, to]. */
  async chain(
    underlying: string,
    right: Right,
    from: string,
    to: string,
  ): Promise<OptionQuote[]> {
    const quotes: OptionQuote[] = [];
    let pageToken: string | undefined;
    do {
      const body = await this.call<{
        snapshots: Record<string, Snapshot> | null;
        next_page_token?: string | null;
      }>(
        this.dataUrl,
        `/v1beta1/options/snapshots/${encodeURIComponent(underlying)}`,
        {
          query: {
            feed: this.feed,
            type: right,
            expiration_date_gte: from,
            expiration_date_lte: to,
            limit: "1000",
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        },
      );
      for (const [symbol, s] of Object.entries(body.snapshots ?? {}))
        quotes.push(quote(symbol, s));
      pageToken = body.next_page_token ?? undefined;
    } while (pageToken);
    return quotes;
  }

  async quote(symbol: string): Promise<OptionQuote> {
    const body = await this.call<{ snapshots: Record<string, Snapshot> }>(
      this.dataUrl,
      "/v1beta1/options/snapshots",
      { query: { symbols: symbol, feed: this.feed } },
    );
    const s = body.snapshots?.[symbol];
    if (!s) throw new Error(`No quote for ${symbol}`);
    return quote(symbol, s);
  }

  async buyLimit(symbol: string, qty: number, limitPrice: number) {
    return order(
      await this.call<RawOrder>(this.tradingUrl, "/v2/orders", {
        method: "POST",
        body: {
          symbol,
          qty: String(qty),
          side: "buy",
          type: "limit",
          time_in_force: "day",
          limit_price: limitPrice.toFixed(2),
        },
      }),
    );
  }

  /** Replaces the limit price; Alpaca answers with a new order id. */
  async replace(id: string, limitPrice: number) {
    return order(
      await this.call<RawOrder>(this.tradingUrl, `/v2/orders/${id}`, {
        method: "PATCH",
        body: { limit_price: limitPrice.toFixed(2) },
      }),
    );
  }

  async order(id: string) {
    return order(
      await this.call<RawOrder>(this.tradingUrl, `/v2/orders/${id}`),
    );
  }
}

export type TradingClient = Pick<
  AlpacaTrading,
  "quote" | "buyLimit" | "replace" | "order"
>;
