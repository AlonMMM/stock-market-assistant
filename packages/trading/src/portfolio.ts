import { liveUrl, paperUrl } from "./alpaca-trading.js";
import { parseOccSymbol, type Right } from "./options.js";
import { estimateOption } from "./option-estimate.js";
import { shortRisks } from "./safety.js";

// Read-only view of the Alpaca trading account for the site's Portfolio tab:
// account totals, open positions with their stop, and working orders. It only
// sends GET requests.

export interface PortfolioStop {
  price: number;
  qty: number; // contracts or shares the stop orders cover
  // Loss at the stop as a share of the entry price, in percent.
  lossPct: number;
  // Money lost on the covered quantity if it sells at the stop price.
  risk: number;
}

export interface Contract {
  symbol: string;
  underlying: string;
  option: { right: Right; strike: number; expiry: string } | null;
}

export interface PortfolioPosition extends Contract {
  qty: number;
  entry: number; // average entry price
  price: number | null; // current price
  value: number | null; // market value
  cost: number;
  pnl: number | null; // unrealized, since entry
  pnlPct: number | null;
  dayPnl: number | null;
  // Market value as a share of account equity, in percent.
  sharePct: number | null;
  // Market-data enrichment for options; all may be null when the feed omits it.
  underlyingPrice: number | null;
  underlyingPriceSource: "trade" | "quote" | "bar" | "close" | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  impliedVolatility: number | null;
  estimatedPrice: number | null;
  // Latest available underlying mark when the US options market is closed.
  overnightPrice: number | null;
  estimateBreakdown: {
    model: "black-scholes" | "greeks";
    optionMark: number;
    // Underlying price when the option mark was set: the one-minute bar of
    // that moment, or that day's close when the bar is unavailable.
    underlyingReference: number;
    underlyingReferenceSource: "live" | "minute" | "close";
    underlyingMove: number;
    moveEffect: number;
    timeEffect: number;
    volatility: number | null;
    elapsedDays: number;
  } | null;
  estimateAsOf: string | null;
  underlyingAsOf: string | null;
  marketDataIssue: string | null;
  stop: PortfolioStop | null;
}

export interface PortfolioOrder extends Contract {
  id: string;
  side: "buy" | "sell";
  type: string;
  qty: number;
  filledQty: number;
  limitPrice: number | null;
  stopPrice: number | null;
  status: string;
  submittedAt: string | null;
}

export interface Portfolio {
  paper: boolean;
  at: string;
  marketClosed: boolean;
  account: {
    equity: number;
    cash: number;
    buyingPower: number;
    // Change in equity since the previous close.
    dayChange: number;
    dayChangePct: number | null;
  };
  overnightEstimate: {
    equity: number | null;
    change: number | null;
    pricedPositions: number;
    totalPositions: number;
  } | null;
  positions: PortfolioPosition[];
  // Open orders, including the stops shown on their positions.
  orders: PortfolioOrder[];
  // Money lost if every stop fills at its price; positions without a stop
  // are not counted.
  riskAtStops: number;
  unprotected: number; // positions with no stop, or one covering only part
  // Must stay empty: a short option or stock position, or sell orders for
  // more than is held (safety.ts).
  shortRisks: string[];
}

interface RawAccount {
  equity: string;
  last_equity: string;
  cash: string;
  buying_power: string;
}

interface RawClock {
  is_open: boolean;
}

interface RawPosition {
  symbol: string;
  asset_class: string;
  qty: string;
  avg_entry_price: string;
  current_price: string | null;
  market_value: string | null;
  cost_basis: string;
  unrealized_pl: string | null;
  unrealized_plpc: string | null;
  unrealized_intraday_pl: string | null;
}

interface RawOrder {
  id: string;
  symbol: string;
  side: string;
  type: string;
  qty: string | null;
  filled_qty: string;
  limit_price: string | null;
  stop_price: string | null;
  status: string;
  submitted_at: string | null;
}

const num = (v: string | null | undefined) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round = (n: number, digits = 2) => Number(n.toFixed(digits));
const marketDataUrl = "https://data.alpaca.markets";

// Option symbols are in OCC form; anything else is a stock ticker.
function contract(symbol: string): Contract {
  try {
    const { underlying, ...option } = parseOccSymbol(symbol);
    return { symbol, underlying, option };
  } catch {
    return { symbol, underlying: symbol, option: null };
  }
}

function position(
  raw: RawPosition,
  orders: PortfolioOrder[],
  equity: number,
): PortfolioPosition {
  const named = contract(raw.symbol);
  const isOption = named.option !== null;
  const qty = Number(raw.qty);
  const entry = Number(raw.avg_entry_price);
  const value = num(raw.market_value);
  const pnlRatio = num(raw.unrealized_plpc);
  // A long position is protected by its open sell stop orders. With several,
  // the lowest stop price is shown: the most that can be lost.
  const stops = orders.filter(
    (o) =>
      o.symbol === raw.symbol &&
      o.side === "sell" &&
      o.stopPrice !== null &&
      qty > 0,
  );
  const covered = Math.min(
    qty,
    stops.reduce((sum, o) => sum + (o.qty - o.filledQty), 0),
  );
  const stopAt = Math.min(...stops.map((o) => o.stopPrice!));
  return {
    ...named,
    qty,
    entry,
    price: num(raw.current_price),
    value,
    cost: Number(raw.cost_basis),
    pnl: num(raw.unrealized_pl),
    pnlPct: pnlRatio === null ? null : round(pnlRatio * 100),
    dayPnl: num(raw.unrealized_intraday_pl),
    sharePct:
      value === null || !(equity > 0) ? null : round((value / equity) * 100),
    underlyingPrice: null,
    underlyingPriceSource: null,
    delta: null,
    gamma: null,
    theta: null,
    vega: null,
    impliedVolatility: null,
    estimatedPrice: null,
    overnightPrice: null,
    estimateBreakdown: null,
    estimateAsOf: null,
    underlyingAsOf: null,
    marketDataIssue: null,
    stop:
      stops.length === 0 || !(entry > 0)
        ? null
        : {
            price: stopAt,
            qty: covered,
            lossPct: round(((entry - stopAt) / entry) * 100, 1),
            risk: round((entry - stopAt) * covered * (isOption ? 100 : 1)),
          },
  };
}

// The page asks every second, and Alpaca allows 200 trading requests a
// minute for the whole account, orders included. Answers are therefore reused:
// account and positions for just under a second, open orders for five. That
// is at most about 130 requests a minute however many pages are open.
export const portfolioTtlMs = {
  account: 900,
  positions: 900,
  orders: 5000,
  marketData: 10000,
  history: 60000, // daily points and closed trades change slowly
};

/**
 * Keeps the last answer per request. One instance per process; in the hosted
 * Worker it lasts as long as the isolate does.
 */
export class PortfolioCache {
  private entries = new Map<string, { at: number; value: unknown }>();
  async get<T>(
    key: string,
    ttlMs: number,
    now: number,
    load: () => Promise<T>,
  ): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value as T;
    const value = await load();
    this.entries.set(key, { at: now, value });
    return value;
  }
}

interface OptionSnapshot {
  greeks?: { delta?: number; gamma?: number; theta?: number; vega?: number };
  impliedVolatility?: number;
  implied_volatility?: number; // older name
  latestQuote?: { ap?: number; bp?: number; t?: string };
  latestTrade?: { p?: number; t?: string };
}
interface StockSnapshot {
  latestTrade?: { p?: number; t?: string };
  latestQuote?: { ap?: number; bp?: number; t?: string };
  latestMinuteBar?: { c?: number; t?: string };
  minuteBar?: { c?: number; t?: string }; // Alpaca's name in snapshots
  dailyBar?: { c?: number; t?: string };
  prevDailyBar?: { c?: number; t?: string };
  dailyBars?: Array<{ c?: number; t?: string }>;
}

// Alpaca answers the multi-symbol stock snapshot request with symbols at the
// top level, not under `snapshots`; both shapes are read. The snapshot's
// latest minute bar is named `minuteBar`.
type StockSnapshotsBody =
  Record<string, StockSnapshot> | { snapshots?: Record<string, StockSnapshot> };
function stockSnapshotMap(
  body: StockSnapshotsBody | null | undefined,
): Record<string, StockSnapshot> {
  if (!body) return {};
  const map = (
    "snapshots" in body && typeof body.snapshots === "object"
      ? body.snapshots
      : body
  ) as Record<string, StockSnapshot>;
  return Object.fromEntries(
    Object.entries(map ?? {}).map(([symbol, snap]) => [
      symbol,
      { ...snap, latestMinuteBar: snap.latestMinuteBar ?? snap.minuteBar },
    ]),
  );
}

function newer<T extends { t?: string }>(a: T | undefined, b: T | undefined) {
  if (!a) return b;
  if (!b) return a;
  const at = a.t ? Date.parse(a.t) : Number.NaN;
  const bt = b.t ? Date.parse(b.t) : Number.NaN;
  return Number.isFinite(bt) && (!Number.isFinite(at) || bt > at) ? b : a;
}

function mergeStockSnapshots(
  primary: Record<string, StockSnapshot>,
  fallback: Record<string, StockSnapshot>,
): Record<string, StockSnapshot> {
  const merged: Record<string, StockSnapshot> = {};
  for (const symbol of new Set([
    ...Object.keys(primary),
    ...Object.keys(fallback),
  ])) {
    const a = primary[symbol];
    const b = fallback[symbol];
    merged[symbol] = {
      latestTrade: newer(a?.latestTrade, b?.latestTrade),
      latestQuote: newer(a?.latestQuote, b?.latestQuote),
      latestMinuteBar: newer(a?.latestMinuteBar, b?.latestMinuteBar),
      dailyBar: a?.dailyBar ?? b?.dailyBar,
      prevDailyBar: a?.prevDailyBar ?? b?.prevDailyBar,
      dailyBars: [...(a?.dailyBars ?? []), ...(b?.dailyBars ?? [])],
    };
  }
  return merged;
}

const nyDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const nyClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// Alpaca's Algo Trader Plus plan serves overnight stock snapshots on BOATS.
// The normal SIP snapshot feed covers pre-market and after-hours, but not the
// separate 8 PM–4 AM ET overnight session.
function overnightStockFeed(now: number): "boats" | null {
  const parts = Object.fromEntries(
    nyClock.formatToParts(now).map(({ type, value }) => [type, value]),
  );
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  const weekday = parts.weekday;
  const overnight =
    (weekday === "Sun" && minuteOfDay >= 20 * 60) ||
    (["Mon", "Tue", "Wed", "Thu"].includes(weekday!) &&
      (minuteOfDay < 4 * 60 || minuteOfDay >= 20 * 60)) ||
    (weekday === "Fri" && minuteOfDay < 4 * 60);
  return overnight ? "boats" : null;
}

function validPrice(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function stockMark(stock: StockSnapshot | undefined) {
  const tradePrice = validPrice(stock?.latestTrade?.p);
  const bid = validPrice(stock?.latestQuote?.bp);
  const ask = validPrice(stock?.latestQuote?.ap);
  // Extended-hours quotes can be very wide; their mid is then no price.
  const quotePrice =
    bid !== null && ask !== null && ask >= bid && (ask - bid) / ask <= 0.01
      ? (bid + ask) / 2
      : null;
  const tradeTime = stock?.latestTrade?.t
    ? Date.parse(stock.latestTrade.t)
    : Number.NaN;
  const quoteTime = stock?.latestQuote?.t
    ? Date.parse(stock.latestQuote.t)
    : Number.NaN;
  const useQuote =
    quotePrice !== null &&
    (tradePrice === null ||
      (Number.isFinite(quoteTime) &&
        (!Number.isFinite(tradeTime) || quoteTime > tradeTime)));
  const livePrice = useQuote ? quotePrice : tradePrice;
  const liveTime = useQuote ? quoteTime : tradeTime;
  const barPrice = validPrice(stock?.latestMinuteBar?.c);
  const barTime = stock?.latestMinuteBar?.t
    ? Date.parse(stock.latestMinuteBar.t)
    : Number.NaN;
  const useBar =
    barPrice !== null &&
    (livePrice === null ||
      (Number.isFinite(barTime) &&
        (!Number.isFinite(liveTime) || barTime > liveTime)));
  if (useBar)
    return {
      price: barPrice,
      source: "bar" as const,
      asOf: stock?.latestMinuteBar?.t ?? null,
    };
  if (useQuote)
    return {
      price: quotePrice,
      source: "quote" as const,
      asOf: stock?.latestQuote?.t ?? null,
    };
  if (tradePrice !== null)
    return {
      price: tradePrice,
      source: "trade" as const,
      asOf: stock?.latestTrade?.t ?? null,
    };
  const close = validPrice(stock?.dailyBar?.c);
  if (close !== null)
    return {
      price: close,
      source: "close" as const,
      asOf: stock?.dailyBar?.t ?? null,
    };
  const previousClose = validPrice(stock?.prevDailyBar?.c);
  if (previousClose !== null)
    return {
      price: previousClose,
      source: "close" as const,
      asOf: stock?.prevDailyBar?.t ?? null,
    };
  return { price: null, source: null, asOf: null };
}

function estimateOvernightPortfolio(
  equity: number,
  positions: PortfolioPosition[],
  stockSnapshots: Record<string, StockSnapshot>,
) {
  let adjustment = 0;
  let pricedPositions = 0;
  for (const p of positions) {
    if (p.option) {
      if (p.price === null || p.estimatedPrice === null) continue;
      adjustment += (p.estimatedPrice - p.price) * p.qty * 100;
      pricedPositions++;
      continue;
    }
    const marketPrice = stockMark(stockSnapshots[p.symbol]).price;
    if (p.price === null || marketPrice === null) continue;
    adjustment += (marketPrice - p.price) * p.qty;
    pricedPositions++;
  }
  if (pricedPositions === 0)
    return {
      equity: null,
      change: null,
      pricedPositions,
      totalPositions: positions.length,
    };
  return {
    equity: round(equity + adjustment),
    change: round(adjustment),
    pricedPositions,
    totalPositions: positions.length,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Market-data request failed";
}

function estimatedOptionPrice(
  position: PortfolioPosition,
  option: OptionSnapshot | undefined,
  stock: StockSnapshot | undefined,
  now: number,
  fetchIssues: string[],
  minuteBars?: Array<{ c?: number; t?: string }>,
  regular: StockSnapshot | undefined = stock,
) {
  const delta = option?.greeks?.delta;
  const gamma = option?.greeks?.gamma;
  const theta = option?.greeks?.theta;
  const vega = option?.greeks?.vega;
  const impliedVolatility =
    option?.impliedVolatility ?? option?.implied_volatility;
  const stockPrice = stockMark(stock);
  const current = stockPrice.price;
  const underlyingPriceSource = stockPrice.source;
  const underlyingAsOf = stockPrice.asOf;
  const bid = validPrice(option?.latestQuote?.bp);
  const ask = validPrice(option?.latestQuote?.ap);
  const trade = validPrice(option?.latestTrade?.p);
  const mark =
    bid !== null && ask !== null && ask >= bid
      ? (bid + ask) / 2
      : (trade ?? position.price);
  const issues = [...fetchIssues];
  if (!option && !fetchIssues.some((issue) => issue.startsWith("Options")))
    issues.push("Alpaca returned no option snapshot");
  if (
    current === null &&
    !fetchIssues.some((issue) => issue.startsWith("Stocks"))
  )
    issues.push(
      "Underlying trade, bid/ask quote and latest bar are unavailable",
    );
  if (
    (delta === undefined || gamma === undefined || theta === undefined) &&
    !fetchIssues.some((issue) => issue.startsWith("Options"))
  )
    issues.push("Option Greeks are unavailable");
  if (
    mark === null &&
    !fetchIssues.some((issue) => issue.startsWith("Options"))
  )
    issues.push("Option mark is unavailable");
  if (current === null)
    return {
      ...position,
      delta: delta ?? null,
      gamma: gamma ?? null,
      theta: theta ?? null,
      vega: vega ?? null,
      impliedVolatility: impliedVolatility ?? null,
      marketDataIssue: issues.join(" · ") || null,
    };
  const markAt = markTime(option, position.price);
  // A fresh mark (open market) sits at the latest underlying price.
  const reference =
    markAt === null
      ? null
      : now - markAt < freshMarkMs
        ? { price: current, source: "live" as const }
        : underlyingAt(markAt, minuteBars, regular);
  const estimate =
    reference === null || mark === null || markAt === null || !position.option
      ? null
      : estimateOption({
          right: position.option.right,
          strike: position.option.strike,
          expiry: position.option.expiry,
          mark,
          markAt,
          reference: reference.price,
          spot: current,
          now,
          impliedVolatility: impliedVolatility ?? null,
          greeks:
            delta === undefined || gamma === undefined || theta === undefined
              ? null
              : { delta, gamma, theta },
        });
  if (estimate === null || reference === null || mark === null)
    return {
      ...position,
      underlyingPrice: current,
      underlyingPriceSource,
      underlyingAsOf,
      delta: delta ?? null,
      gamma: gamma ?? null,
      theta: theta ?? null,
      vega: vega ?? null,
      impliedVolatility: impliedVolatility ?? null,
      marketDataIssue:
        issues.join(" · ") ||
        (reference === null
          ? "A matching stock price is unavailable for this option quote"
          : "Neither a volatility nor Greeks are available for this option"),
    };
  return {
    ...position,
    underlyingPrice: current,
    underlyingPriceSource,
    delta: delta ?? null,
    gamma: gamma ?? null,
    theta: theta ?? null,
    vega: vega ?? null,
    impliedVolatility: impliedVolatility ?? null,
    estimatedPrice: round(estimate.price),
    estimateBreakdown: {
      model: estimate.model,
      optionMark: mark,
      underlyingReference: reference.price,
      underlyingReferenceSource: reference.source,
      underlyingMove: current - reference.price,
      moveEffect: estimate.moveEffect,
      timeEffect: estimate.timeEffect,
      // Volatility is held at the level of the last option quote: Alpaca
      // publishes no newer IV while the options market is closed.
      volatility: estimate.volatility,
      elapsedDays: estimate.elapsedDays,
    },
    estimateAsOf: new Date(markAt!).toISOString(),
    underlyingAsOf,
    marketDataIssue: null,
  };
}

// When the option mark was set: its quote when the mark is the quote's
// mid, else its last trade. Alpaca's own position price has no time.
function markTime(
  option: OptionSnapshot | undefined,
  positionPrice: number | null,
): number | null {
  const bid = validPrice(option?.latestQuote?.bp);
  const ask = validPrice(option?.latestQuote?.ap);
  const at =
    bid !== null && ask !== null && ask >= bid
      ? option?.latestQuote?.t
      : validPrice(option?.latestTrade?.p) !== null
        ? option?.latestTrade?.t
        : positionPrice !== null
          ? (option?.latestQuote?.t ?? option?.latestTrade?.t)
          : undefined;
  const time = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

/**
 * Underlying price at the moment the option mark was set. The one-minute bar
 * ending at that moment matches the mark exactly; options that quote until
 * 16:15 (index ETFs) or marks from an earlier day are then still compared
 * with the right stock price. Without that bar, the regular-session close of
 * the same New York day is used (never the overnight BOATS bar).
 */
function underlyingAt(
  markAt: number,
  minuteBars: Array<{ c?: number; t?: string }> | undefined,
  regular: StockSnapshot | undefined,
): { price: number; source: "minute" | "close" } | null {
  let minute: { price: number; t: number } | null = null;
  for (const bar of minuteBars ?? []) {
    const t = bar.t ? Date.parse(bar.t) : Number.NaN;
    const price = validPrice(bar.c);
    // A bar stamped t holds trades of [t, t + 1 min).
    if (price === null || !(t <= markAt) || markAt - t > 15 * 60000) continue;
    if (minute === null || t > minute.t) minute = { price, t };
  }
  if (minute) return { price: minute.price, source: "minute" };
  const day = nyDay.format(markAt);
  const close = validPrice(
    [
      regular?.dailyBar,
      regular?.prevDailyBar,
      ...(regular?.dailyBars ?? []),
    ].find((bar) => bar?.t && nyDay.format(Date.parse(bar.t)) === day)?.c,
  );
  return close === null ? null : { price: close, source: "close" };
}

// One-minute underlying bars around each option mark older than two minutes
// (a closed options market). Marks are grouped by New York hour, so the usual
// case, every mark set at the 16:00 close, takes one request. Failures fall
// back to the daily close.
const maxMinuteBarRequests = 3;
const freshMarkMs = 2 * 60000;
async function underlyingMinuteBars(
  marks: { underlying: string; at: number | null }[],
  now: number,
  dataGet: <T>(path: string) => Promise<T>,
): Promise<Record<string, Array<{ c?: number; t?: string }>>> {
  const groups = new Map<number, Set<string>>();
  for (const { underlying, at } of marks) {
    if (at === null || now - at < freshMarkMs) continue;
    const hour = Math.floor(at / 3600000);
    groups.set(hour, (groups.get(hour) ?? new Set()).add(underlying));
  }
  const requests = [...groups.entries()]
    .sort(([a], [b]) => b - a)
    .slice(0, maxMinuteBarRequests)
    .map(async ([hour, symbols]) => {
      const start = new Date(hour * 3600000 - 15 * 60000).toISOString();
      const end = new Date((hour + 1) * 3600000).toISOString();
      const path = `/v2/stocks/bars?symbols=${encodeURIComponent([...symbols].join(","))}&timeframe=1Min&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=10000&sort=asc`;
      return (
        (
          await dataGet<{
            bars?: Record<string, Array<{ c?: number; t?: string }>>;
          }>(path)
        ).bars ?? {}
      );
    });
  const merged: Record<string, Array<{ c?: number; t?: string }>> = {};
  for (const result of await Promise.allSettled(requests)) {
    if (result.status !== "fulfilled") continue;
    for (const [symbol, bars] of Object.entries(result.value))
      merged[symbol] = [...(merged[symbol] ?? []), ...bars];
  }
  return merged;
}

/**
 * Shared by the local API and the hosted Worker. `live` selects the live
 * account; the keys must belong to the account that is selected.
 */
export async function handlePortfolio(
  credentials: { key?: string; secret?: string },
  live = false,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  cache = new PortfolioCache(),
): Promise<{ status: number; body: Portfolio | { error: string } }> {
  if (!credentials.key || !credentials.secret)
    return {
      status: 503,
      body: { error: "Alpaca credentials are not configured" },
    };
  const base = live ? liveUrl : paperUrl;
  const dataGet = <T>(path: string): Promise<T> =>
    cache.get(
      `${marketDataUrl}${path}`,
      portfolioTtlMs.marketData,
      now,
      async () => {
        const response = await fetcher(new URL(path, marketDataUrl), {
          headers: {
            "APCA-API-KEY-ID": credentials.key!,
            "APCA-API-SECRET-KEY": credentials.secret!,
          },
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok)
          throw new Error(
            `Alpaca market data failed (HTTP ${response.status})`,
          );
        return (await response.json()) as T;
      },
    );
  const get = <T>(path: string, ttlMs: number): Promise<T> =>
    cache.get(`${base}${path}`, ttlMs, now, () => request<T>(path));
  const request = async <T>(path: string): Promise<T> => {
    const response = await fetcher(new URL(path, base), {
      headers: {
        "APCA-API-KEY-ID": credentials.key!,
        "APCA-API-SECRET-KEY": credentials.secret!,
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw new Error(
        response.status === 401 || response.status === 403
          ? `Alpaca refused the keys for the ${live ? "live" : "paper"} account (HTTP ${response.status})`
          : `Alpaca ${path.split("?")[0]} failed (HTTP ${response.status})`,
      );
    return (await response.json()) as T;
  };
  try {
    const [account, rawPositions, rawOrders, clock] = await Promise.all([
      get<RawAccount>("/v2/account", portfolioTtlMs.account),
      get<RawPosition[]>("/v2/positions", portfolioTtlMs.positions),
      get<RawOrder[]>(
        "/v2/orders?status=open&limit=500",
        portfolioTtlMs.orders,
      ),
      get<RawClock>("/v2/clock", portfolioTtlMs.account).catch(() => null),
    ]);
    const marketClosed = clock?.is_open === false;
    const equity = Number(account.equity);
    const lastEquity = Number(account.last_equity);
    const orders = rawOrders.map((o): PortfolioOrder => ({
      ...contract(o.symbol),
      id: o.id,
      side: o.side === "sell" ? "sell" : "buy",
      type: o.type,
      qty: Number(o.qty ?? 0),
      filledQty: Number(o.filled_qty),
      limitPrice: num(o.limit_price),
      stopPrice: num(o.stop_price),
      status: o.status,
      submittedAt: o.submitted_at,
    }));
    let positions = rawPositions
      .map((p) => position(p, orders, equity))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const options = positions.filter((p) => p.option !== null);
    const feed = overnightStockFeed(now);
    let overnightEstimate: Portfolio["overnightEstimate"] = null;
    if (marketClosed && positions.length === 0)
      overnightEstimate = {
        equity: null,
        change: null,
        pricedPositions: 0,
        totalPositions: 0,
      };
    if (options.length > 0 || (marketClosed && positions.length > 0)) {
      const optionSymbols = options.map((p) => p.symbol).join(",");
      const symbols = [
        ...new Set([
          ...options.map((p) => p.underlying),
          ...(marketClosed
            ? positions.filter((p) => !p.option).map((p) => p.symbol)
            : []),
        ]),
      ].join(",");
      let stockSnapshots: Record<string, StockSnapshot> = {};
      const regularStockUrl = `/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols)}`;
      const latestBarsUrl = `/v2/stocks/bars/latest?symbols=${encodeURIComponent(symbols)}&feed=boats`;
      const historyStart = new Date(now - 14 * 86400000).toISOString();
      const historyEnd = new Date(now + 86400000).toISOString();
      const dailyBarsUrl = `/v2/stocks/bars?symbols=${encodeURIComponent(symbols)}&timeframe=1Day&start=${encodeURIComponent(historyStart)}&end=${encodeURIComponent(historyEnd)}&limit=1000&sort=desc`;
      const [
        optionResult,
        stockResult,
        regularStockResult,
        latestBarsResult,
        dailyBarsResult,
      ] = await Promise.all([
        Promise.allSettled([
          optionSymbols
            ? dataGet<{ snapshots?: Record<string, OptionSnapshot> }>(
                `/v1beta1/options/snapshots?symbols=${encodeURIComponent(optionSymbols)}`,
              )
            : Promise.resolve({ snapshots: {} }),
          dataGet<StockSnapshotsBody>(
            `/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols)}${feed ? `&feed=${feed}` : ""}`,
          ),
        ]),
        feed
          ? Promise.allSettled([dataGet<StockSnapshotsBody>(regularStockUrl)])
          : Promise.resolve(null),
        feed
          ? Promise.allSettled([
              dataGet<{
                bars?: Record<string, { c?: number; t?: string }>;
              }>(latestBarsUrl),
            ])
          : Promise.resolve(null),
        feed && options.length > 0
          ? Promise.allSettled([
              dataGet<{
                bars?: Record<string, Array<{ c?: number; t?: string }>>;
              }>(dailyBarsUrl),
            ])
          : Promise.resolve(null),
      ]).then(
        ([primary, fallback, bars, daily]) =>
          [
            primary[0]!,
            primary[1]!,
            fallback?.[0] ?? null,
            bars?.[0] ?? null,
            daily?.[0] ?? null,
          ] as const,
      );
      const optionSnapshots: Record<string, OptionSnapshot> =
        optionResult.status === "fulfilled"
          ? (optionResult.value.snapshots ?? {})
          : {};
      const overnightStockSnapshots: Record<string, StockSnapshot> =
        stockResult.status === "fulfilled"
          ? stockSnapshotMap(stockResult.value)
          : {};
      const regularStockSnapshots =
        regularStockResult?.status === "fulfilled"
          ? stockSnapshotMap(regularStockResult.value)
          : {};
      stockSnapshots = feed
        ? mergeStockSnapshots(overnightStockSnapshots, regularStockSnapshots)
        : overnightStockSnapshots;
      const latestBars =
        latestBarsResult?.status === "fulfilled"
          ? (latestBarsResult.value?.bars ?? {})
          : {};
      if (feed && Object.keys(latestBars).length > 0) {
        stockSnapshots = { ...stockSnapshots };
        for (const [symbol, bar] of Object.entries(latestBars)) {
          stockSnapshots[symbol] = {
            ...(stockSnapshots[symbol] ?? {}),
            latestMinuteBar: bar,
          };
        }
      }
      const dailyBars =
        dailyBarsResult?.status === "fulfilled"
          ? (dailyBarsResult.value?.bars ?? {})
          : {};
      if (feed && Object.keys(dailyBars).length > 0) {
        stockSnapshots = { ...stockSnapshots };
        for (const [symbol, bars] of Object.entries(dailyBars)) {
          stockSnapshots[symbol] = {
            ...(stockSnapshots[symbol] ?? {}),
            dailyBars: bars,
          };
        }
      }
      const fetchIssues = [
        ...(optionResult.status === "rejected"
          ? [`Options: ${errorMessage(optionResult.reason)}`]
          : []),
        ...(stockResult.status === "rejected"
          ? [
              `Stocks${feed ? ` ${feed.toUpperCase()}` : ""}: ${errorMessage(stockResult.reason)}`,
            ]
          : []),
        ...(regularStockResult?.status === "rejected"
          ? [`Stocks regular feed: ${errorMessage(regularStockResult.reason)}`]
          : []),
        ...(latestBarsResult?.status === "rejected"
          ? [`Latest stock bars: ${errorMessage(latestBarsResult.reason)}`]
          : []),
        ...(dailyBarsResult?.status === "rejected"
          ? [`Historical stock bars: ${errorMessage(dailyBarsResult.reason)}`]
          : []),
      ];
      // The close reference must come from the regular feed: a BOATS
      // snapshot's daily bar ends with overnight trading, not at 16:00.
      const referenceSnapshots: Record<string, StockSnapshot> = feed
        ? Object.fromEntries(
            Object.keys(stockSnapshots).map((symbol) => [
              symbol,
              {
                dailyBar: regularStockSnapshots[symbol]?.dailyBar,
                prevDailyBar: regularStockSnapshots[symbol]?.prevDailyBar,
                dailyBars: dailyBars[symbol] ?? [],
              },
            ]),
          )
        : stockSnapshots;
      const minuteBars = await underlyingMinuteBars(
        options.map((p) => ({
          underlying: p.underlying,
          at: markTime(optionSnapshots[p.symbol], p.price),
        })),
        now,
        dataGet,
      );
      positions = positions.map((p) =>
        p.option
          ? estimatedOptionPrice(
              p,
              optionSnapshots[p.symbol],
              stockSnapshots[p.underlying],
              now,
              fetchIssues,
              minuteBars[p.underlying],
              referenceSnapshots[p.underlying],
            )
          : marketClosed
            ? {
                ...p,
                overnightPrice: stockMark(stockSnapshots[p.symbol]).price,
              }
            : p,
      );
      if (marketClosed)
        overnightEstimate = estimateOvernightPortfolio(
          equity,
          positions,
          stockSnapshots,
        );
    }
    return {
      status: 200,
      body: {
        paper: !live,
        at: new Date(now).toISOString(),
        marketClosed,
        account: {
          equity,
          cash: Number(account.cash),
          buyingPower: Number(account.buying_power),
          dayChange: round(equity - lastEquity),
          dayChangePct:
            lastEquity > 0
              ? round(((equity - lastEquity) / lastEquity) * 100)
              : null,
        },
        overnightEstimate,
        positions,
        orders,
        riskAtStops: round(
          positions.reduce((sum, p) => sum + (p.stop?.risk ?? 0), 0),
        ),
        // Options and stocks: neither may ever be short.
        shortRisks: shortRisks(positions, orders),
        unprotected: positions.filter(
          (p) => p.qty > 0 && (p.stop?.qty ?? 0) < p.qty,
        ).length,
      },
    };
  } catch (error) {
    return {
      status: 502,
      body: {
        error:
          error instanceof Error ? error.message : "Portfolio request failed",
      },
    };
  }
}

// ---------------------------------------------------------------------------
// History: profit and loss over time, and the trades that were closed.

export const historyPeriods = ["1W", "1M", "3M", "1A"] as const;
export type HistoryPeriod = (typeof historyPeriods)[number];

export interface ClosedTrade extends Contract {
  openedAt: string; // first buy
  closedAt: string; // the fill or expiry that brought the position to zero
  qty: number; // contracts or shares bought
  entry: number; // average buy price
  exit: number; // average sell price; 0 for what expired
  pnl: number;
  pnlPct: number | null;
  expired: boolean; // closed by expiry instead of a sale
}

export interface PortfolioHistory {
  from: string; // start of the selected trade-history period
  baseEquity: number | null; // Alpaca base_value for account-level returns
  paper: boolean;
  at: string;
  period: HistoryPeriod;
  // One point per trading day. `pnl` is Alpaca's profit and loss since the
  // start of the period.
  points: { date: string; equity: number; pnl: number }[];
  pnl: number; // at the last point
  pnlPct: number | null; // of the equity the period started with
  // Closed in the period, newest first. Built from the account's most recent
  // `activityLimit` fills, so older trades may be missing.
  trades: ClosedTrade[];
  realized: number; // sum of the trades' pnl
  wins: number;
  activityLimit: number;
  truncated: boolean; // the account has more activity than was read
}

interface RawHistory {
  timestamp: number[];
  equity: (number | null)[];
  profit_loss: (number | null)[];
  base_value: number;
}

interface RawActivity {
  id: string;
  activity_type: string;
  symbol?: string;
  side?: string;
  qty?: string;
  price?: string;
  transaction_time?: string; // fills
  date?: string; // expiries
}

// Alpaca stamps a daily point at midnight UTC after the session, which is
// still that trading day in New York.
const tradingDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const activityPage = 100;
const activityPages = 5;
const periodDays: Record<HistoryPeriod, number> = {
  "1W": 7,
  "1M": 31,
  "3M": 92,
  "1A": 366,
};

/**
 * Pairs fills into closed trades. A trade runs from the first buy of a
 * contract until its position is back to zero, by sales or by expiry. Only
 * long positions are tracked; a sale with nothing open is ignored (its buy is
 * older than the activity that was read).
 */
export function closedTrades(activities: RawActivity[]): ClosedTrade[] {
  const time = (a: RawActivity) =>
    a.transaction_time ?? (a.date ? `${a.date}T20:00:00Z` : "");
  const open = new Map<
    string,
    {
      held: number;
      bought: number;
      cost: number;
      sold: number;
      openedAt: string;
    }
  >();
  const trades: ClosedTrade[] = [];
  const ordered = activities
    .filter((a) => a.symbol && time(a))
    .sort((a, b) => time(a).localeCompare(time(b)));
  for (const a of ordered) {
    const symbol = a.symbol!;
    const expiry = a.activity_type === "OPEXP";
    const qty = Math.abs(Number(a.qty ?? 0));
    const price = Number(a.price ?? 0);
    let p = open.get(symbol);
    if (a.activity_type === "FILL" && a.side === "buy") {
      if (!(qty > 0)) continue;
      if (!p) {
        p = { held: 0, bought: 0, cost: 0, sold: 0, openedAt: time(a) };
        open.set(symbol, p);
      }
      p.held += qty;
      p.bought += qty;
      p.cost += qty * price;
      continue;
    }
    if (!p || !(expiry || a.activity_type === "FILL")) continue;
    // An expiry closes whatever is still held, at zero.
    const closing = expiry ? p.held : Math.min(qty, p.held);
    p.held -= closing;
    if (!expiry) p.sold += closing * price;
    if (p.held > 1e-9) continue;
    open.delete(symbol);
    const named = contract(symbol);
    const multiplier = named.option ? 100 : 1;
    trades.push({
      ...named,
      openedAt: p.openedAt,
      closedAt: time(a),
      qty: p.bought,
      entry: round(p.cost / p.bought, 4),
      exit: round(p.sold / p.bought, 4),
      pnl: round((p.sold - p.cost) * multiplier),
      pnlPct: p.cost > 0 ? round(((p.sold - p.cost) / p.cost) * 100, 1) : null,
      expired: expiry,
    });
  }
  return trades.reverse();
}

/** `GET /api/portfolio/history?period=1M`: shared by the API and the Worker. */
export async function handlePortfolioHistory(
  credentials: { key?: string; secret?: string },
  period: unknown,
  live = false,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  cache = new PortfolioCache(),
): Promise<{ status: number; body: PortfolioHistory | { error: string } }> {
  if (!credentials.key || !credentials.secret)
    return {
      status: 503,
      body: { error: "Alpaca credentials are not configured" },
    };
  const chosen = period === undefined || period === "" ? "1M" : period;
  if (!historyPeriods.includes(chosen as HistoryPeriod))
    return {
      status: 400,
      body: { error: `period must be one of ${historyPeriods.join(", ")}` },
    };
  const base = live ? liveUrl : paperUrl;
  const request = async <T>(path: string): Promise<T> => {
    const response = await fetcher(new URL(path, base), {
      headers: {
        "APCA-API-KEY-ID": credentials.key!,
        "APCA-API-SECRET-KEY": credentials.secret!,
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw new Error(
        response.status === 401 || response.status === 403
          ? `Alpaca refused the keys for the ${live ? "live" : "paper"} account (HTTP ${response.status})`
          : `Alpaca ${path.split("?")[0]} failed (HTTP ${response.status})`,
      );
    return (await response.json()) as T;
  };
  const get = <T>(path: string): Promise<T> =>
    cache.get(`${base}${path}`, portfolioTtlMs.history, now, () =>
      request<T>(path),
    );
  // Newest first, a page at a time, up to `activityPages` pages.
  const activities = async () => {
    const all: RawActivity[] = [];
    let token = "";
    for (let page = 0; page < activityPages; page++) {
      const batch = await request<RawActivity[]>(
        `/v2/account/activities?activity_types=FILL,OPEXP&direction=desc&page_size=${activityPage}${token && `&page_token=${token}`}`,
      );
      all.push(...batch);
      if (batch.length < activityPage) return { all, truncated: false };
      token = encodeURIComponent(batch.at(-1)!.id);
    }
    return { all, truncated: true };
  };
  try {
    const [history, activity] = await Promise.all([
      get<RawHistory>(
        `/v2/account/portfolio/history?period=${chosen}&timeframe=1D`,
      ),
      cache.get(`${base}activities`, portfolioTtlMs.history, now, activities),
    ]);
    const points = history.timestamp.flatMap((t, i) => {
      const equity = history.equity[i];
      const pnl = history.profit_loss[i];
      return equity === null || equity === undefined
        ? []
        : [
            {
              date: tradingDay.format(t * 1000),
              equity: round(equity),
              pnl: round(pnl ?? 0),
            },
          ];
    });
    const from = new Date(
      now - periodDays[chosen as HistoryPeriod] * 86400000,
    ).toISOString();
    const trades = closedTrades(activity.all).filter((t) => t.closedAt >= from);
    const pnl = points.at(-1)?.pnl ?? 0;
    return {
      status: 200,
      body: {
        paper: !live,
        at: new Date(now).toISOString(),
        period: chosen as HistoryPeriod,
        from,
        baseEquity: history.base_value > 0 ? history.base_value : null,
        points,
        pnl,
        pnlPct:
          history.base_value > 0
            ? round((pnl / history.base_value) * 100)
            : null,
        trades,
        realized: round(trades.reduce((sum, t) => sum + t.pnl, 0)),
        wins: trades.filter((t) => t.pnl > 0).length,
        activityLimit: activityPage * activityPages,
        truncated: activity.truncated,
      },
    };
  } catch (error) {
    return {
      status: 502,
      body: {
        error:
          error instanceof Error ? error.message : "Portfolio request failed",
      },
    };
  }
}
