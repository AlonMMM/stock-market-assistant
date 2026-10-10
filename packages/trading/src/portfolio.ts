import { liveUrl, paperUrl } from "./alpaca-trading.js";
import { parseOccSymbol, type Right } from "./options.js";

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
  account: {
    equity: number;
    cash: number;
    buyingPower: number;
    // Change in equity since the previous close.
    dayChange: number;
    dayChangePct: number | null;
  };
  positions: PortfolioPosition[];
  // Open orders, including the stops shown on their positions.
  orders: PortfolioOrder[];
  // Money lost if every stop fills at its price; positions without a stop
  // are not counted.
  riskAtStops: number;
  unprotected: number; // positions with no stop, or one covering only part
}

interface RawAccount {
  equity: string;
  last_equity: string;
  cash: string;
  buying_power: string;
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
export const portfolioTtlMs = { account: 900, positions: 900, orders: 5000 };

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
    const [account, rawPositions, rawOrders] = await Promise.all([
      get<RawAccount>("/v2/account", portfolioTtlMs.account),
      get<RawPosition[]>("/v2/positions", portfolioTtlMs.positions),
      get<RawOrder[]>(
        "/v2/orders?status=open&limit=500",
        portfolioTtlMs.orders,
      ),
    ]);
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
    const positions = rawPositions
      .map((p) => position(p, orders, equity))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return {
      status: 200,
      body: {
        paper: !live,
        at: new Date(now).toISOString(),
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
        positions,
        orders,
        riskAtStops: round(
          positions.reduce((sum, p) => sum + (p.stop?.risk ?? 0), 0),
        ),
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
