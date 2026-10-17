import type {
  Account,
  Broker,
  BrokerCapabilities,
  OrderChange,
  Order,
  StockQuote,
  StockTicket,
} from "./broker.js";
import { parseOccSymbol, type OptionQuote, type Right } from "./options.js";

type Fetcher = typeof fetch;

export const paperUrl = "https://paper-api.alpaca.markets";
export const liveUrl = "https://api.alpaca.markets";

export type { Order, TradingClient } from "./broker.js";

interface Snapshot {
  latestQuote?: { bp?: number; ap?: number; t?: string };
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
  replaced_by?: string | null;
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
  ...(raw.replaced_by ? { replacedBy: raw.replaced_by } : {}),
});

function quote(symbol: string, s: Snapshot): OptionQuote {
  const parsed = parseOccSymbol(symbol);
  const delta = s.greeks?.delta;
  const at = s.latestQuote?.t ? Date.parse(s.latestQuote.t) : undefined;
  return {
    symbol,
    ...parsed,
    bid: s.latestQuote?.bp ?? 0,
    ask: s.latestQuote?.ap ?? 0,
    delta: typeof delta === "number" && Number.isFinite(delta) ? delta : null,
    ...(at !== undefined && Number.isFinite(at) ? { quotedAt: at } : {}),
  };
}

/** Alpaca's own words for a refusal, out of its JSON error body. */
function reason(text: string): string {
  try {
    const body = JSON.parse(text) as { message?: unknown };
    if (typeof body.message === "string" && body.message)
      return body.message.slice(0, 300);
  } catch {
    // Not JSON: shown as it came.
  }
  return text.slice(0, 300) || "no reason given";
}

// Stocks at $1 or more trade in cents; below $1, in 1/100 of a cent.
const stockPriceText = (price: number) =>
  price >= 1 ? price.toFixed(2) : price.toFixed(4);

// A daily point is labelled with its New York trading day.
const tradingDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
});

// Alpaca Trading API (account and orders) plus option snapshots from the
// Market Data API. Paper trading unless the caller passes liveUrl.
export class AlpacaTrading implements Broker {
  readonly name = "alpaca";
  constructor(
    private key: string,
    private secret: string,
    private tradingUrl = paperUrl,
    private feed: "opra" | "indicative" = "opra",
    private fetcher: Fetcher = fetch,
    private dataUrl = "https://data.alpaca.markets",
  ) {}

  get capabilities(): BrokerCapabilities {
    return {
      paper: this.tradingUrl === paperUrl,
      // `position_intent: sell_to_close`, verified on paper 2026-10-10.
      closeOnlyOrders: true,
      optionStops: true,
      replaceInPlace: true,
    };
  }

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
        `Alpaca refused ${init.method ?? "GET"} ${url.pathname} (HTTP ${response.status}): ${reason(text)}`,
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

  async account(): Promise<Account> {
    const a = await this.call<{
      equity: string;
      last_equity: string;
      buying_power: string;
      options_buying_power?: string;
    }>(this.tradingUrl, "/v2/account");
    return {
      equity: Number(a.equity),
      lastEquity: Number(a.last_equity),
      buyingPower: Number(a.options_buying_power ?? a.buying_power),
    };
  }

  async marketOpen(): Promise<boolean> {
    const clock = await this.call<{ is_open: boolean }>(
      this.tradingUrl,
      "/v2/clock",
    );
    return clock.is_open === true;
  }

  async equityHistory() {
    const h = await this.call<{
      timestamp: number[];
      equity: (number | null)[];
    }>(this.tradingUrl, "/v2/account/portfolio/history", {
      query: { period: "1A", timeframe: "1D" },
    });
    return h.timestamp.flatMap((t, i) => {
      const equity = h.equity[i];
      return typeof equity === "number" && equity > 0
        ? [{ date: tradingDay.format(t * 1000), equity }]
        : [];
    });
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

  async stockPrice(symbol: string): Promise<number | null> {
    // No `feed`: Alpaca uses the best one the account is subscribed to.
    const body = await this.call<{ trade?: { p?: number } }>(
      this.dataUrl,
      `/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`,
    );
    const price = body?.trade?.p;
    return typeof price === "number" && price > 0 ? price : null;
  }

  async stockQuote(symbol: string): Promise<StockQuote> {
    // No `feed`: the best one the account has; SIP covers extended hours.
    const body = await this.call<{
      latestQuote?: { bp?: number; ap?: number; t?: string };
      latestTrade?: { p?: number };
    }>(this.dataUrl, `/v2/stocks/${encodeURIComponent(symbol)}/snapshot`);
    const positive = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
    const at = body?.latestQuote?.t ? Date.parse(body.latestQuote.t) : NaN;
    return {
      symbol,
      bid: positive(body?.latestQuote?.bp),
      ask: positive(body?.latestQuote?.ap),
      last: positive(body?.latestTrade?.p),
      ...(Number.isFinite(at) ? { quotedAt: at } : {}),
    };
  }

  /**
   * Whole shares, day limit, `extended_hours` so it can also fill in pre- and
   * after-hours. Alpaca accepts that only for limit day orders.
   */
  async stockLimit(
    symbol: string,
    side: "buy" | "sell",
    qty: number,
    limitPrice: number,
  ) {
    return order(
      await this.call<RawOrder>(this.tradingUrl, "/v2/orders", {
        method: "POST",
        body: {
          symbol,
          qty: String(qty),
          side,
          type: "limit",
          time_in_force: "day",
          extended_hours: true,
          limit_price: stockPriceText(limitPrice),
        },
      }),
    );
  }

  /**
   * A stock order of any type Alpaca offers. The caller has already checked
   * the ticket (`stockTicket`), including that a sell only closes held shares.
   */
  async stockOrder(t: StockTicket) {
    return order(
      await this.call<RawOrder>(this.tradingUrl, "/v2/orders", {
        method: "POST",
        body: {
          symbol: t.symbol,
          qty: String(t.qty),
          side: t.side,
          type: t.type,
          time_in_force: t.timeInForce,
          ...(t.limitPrice === undefined
            ? {}
            : { limit_price: stockPriceText(t.limitPrice) }),
          ...(t.stopPrice === undefined
            ? {}
            : { stop_price: stockPriceText(t.stopPrice) }),
          ...(t.trailPercent === undefined
            ? {}
            : { trail_percent: String(t.trailPercent) }),
          ...(t.trailPrice === undefined
            ? {}
            : { trail_price: stockPriceText(t.trailPrice) }),
          ...(t.extendedHours ? { extended_hours: true } : {}),
        },
      }),
    );
  }

  /**
   * Changes an open order. `trail` is sent as `trail` (Alpaca applies it to
   * the order's own trail kind). Alpaca answers with a new order id.
   */
  async changeOrder(id: string, c: OrderChange) {
    return order(
      await this.call<RawOrder>(this.tradingUrl, `/v2/orders/${id}`, {
        method: "PATCH",
        body: {
          ...(c.qty === undefined ? {} : { qty: String(c.qty) }),
          ...(c.limitPrice === undefined
            ? {}
            : { limit_price: stockPriceText(c.limitPrice) }),
          ...(c.stopPrice === undefined
            ? {}
            : { stop_price: stockPriceText(c.stopPrice) }),
          ...(c.trail === undefined ? {} : { trail: String(c.trail) }),
          ...(c.timeInForce === undefined
            ? {}
            : { time_in_force: c.timeInForce }),
        },
      }),
    );
  }

  /** Stock positions; a short one has a negative quantity. */
  async stockPositions() {
    const raw = await this.call<
      {
        symbol: string;
        asset_class: string;
        qty: string;
        avg_entry_price: string;
      }[]
    >(this.tradingUrl, "/v2/positions");
    return raw
      .filter((p) => p.asset_class === "us_equity")
      .map((p) => ({
        symbol: p.symbol,
        qty: Number(p.qty),
        avgEntryPrice: Number(p.avg_entry_price),
      }));
  }

  async buyLimit(symbol: string, qty: number, limitPrice: number) {
    return order(
      await this.call<RawOrder>(this.tradingUrl, "/v2/orders", {
        method: "POST",
        body: {
          symbol,
          qty: String(qty),
          side: "buy",
          position_intent: "buy_to_open",
          type: "limit",
          time_in_force: "day",
          limit_price: limitPrice.toFixed(2),
        },
      }),
    );
  }

  /**
   * Stop loss for a long option: once a trade prints at or below `stop`, it
   * becomes a market sell. Good till canceled.
   */
  async sellStop(symbol: string, qty: number, stop: number) {
    return order(
      await this.call<RawOrder>(this.tradingUrl, "/v2/orders", {
        method: "POST",
        body: {
          symbol,
          qty: String(qty),
          side: "sell",
          // Close-only: the broker refuses it when it would open a short.
          position_intent: "sell_to_close",
          type: "stop",
          time_in_force: "gtc",
          stop_price: stop.toFixed(2),
        },
      }),
    );
  }

  /** Changes a stop's quantity and price; Alpaca answers with a new order id. */
  async replaceStop(id: string, qty: number, stop: number) {
    return order(
      await this.call<RawOrder>(this.tradingUrl, `/v2/orders/${id}`, {
        method: "PATCH",
        body: { qty: String(qty), stop_price: stop.toFixed(2) },
      }),
    );
  }

  /** A day limit sell. */
  async sellLimit(symbol: string, qty: number, limitPrice: number) {
    return order(
      await this.call<RawOrder>(this.tradingUrl, "/v2/orders", {
        method: "POST",
        body: {
          symbol,
          qty: String(qty),
          side: "sell",
          // Close-only: the broker refuses it when it would open a short.
          position_intent: "sell_to_close",
          type: "limit",
          time_in_force: "day",
          limit_price: limitPrice.toFixed(2),
        },
      }),
    );
  }

  /** Open orders, for one contract or all, with their side and stop price. */
  async openOrders(symbol?: string) {
    const raw = await this.call<
      (RawOrder & {
        side: string;
        stop_price: string | null;
        type: string;
        time_in_force: string;
        trail_percent?: string | null;
        trail_price?: string | null;
        extended_hours?: boolean;
      })[]
    >(this.tradingUrl, "/v2/orders", {
      query: {
        status: "open",
        limit: "500",
        ...(symbol ? { symbols: symbol } : {}),
      },
    });
    const num = (v: string | null | undefined) =>
      v === null || v === undefined ? null : Number(v);
    return raw.map((o) => ({
      ...order(o),
      side: o.side,
      stopPrice: num(o.stop_price),
      type: o.type,
      timeInForce: o.time_in_force,
      trailPercent: num(o.trail_percent),
      trailPrice: num(o.trail_price),
      extendedHours: o.extended_hours === true,
    }));
  }

  /** Option positions; a short one has a negative quantity. */
  async positions() {
    const raw = await this.call<
      {
        symbol: string;
        asset_class: string;
        qty: string;
        avg_entry_price: string;
      }[]
    >(this.tradingUrl, "/v2/positions");
    return raw
      .filter((p) => p.asset_class === "us_option")
      .map((p) => ({
        symbol: p.symbol,
        qty: Number(p.qty),
        avgEntryPrice: Number(p.avg_entry_price),
      }));
  }

  /** Withdraws what has not filled. */
  async cancel(id: string) {
    await this.call<null>(this.tradingUrl, `/v2/orders/${id}`, {
      method: "DELETE",
    });
  }

  /** Contracts held and their average entry price. */
  async position(symbol: string) {
    const raw = await this.call<{ qty: string; avg_entry_price: string }>(
      this.tradingUrl,
      `/v2/positions/${encodeURIComponent(symbol)}`,
    );
    return { qty: Number(raw.qty), avgEntryPrice: Number(raw.avg_entry_price) };
  }

  /** Replaces the limit price; Alpaca answers with a new order id. */
  async replace(id: string, limitPrice: number) {
    return order(
      await this.call<RawOrder>(this.tradingUrl, `/v2/orders/${id}`, {
        method: "PATCH",
        body: { limit_price: stockPriceText(limitPrice) },
      }),
    );
  }

  async order(id: string) {
    return order(
      await this.call<RawOrder>(this.tradingUrl, `/v2/orders/${id}`),
    );
  }
}
