import { newYork } from "../../../packages/market-data/src/calendar.js";
import type { Broker } from "../../../packages/trading/src/broker.js";
import { parseOccSymbol } from "../../../packages/trading/src/options.js";
import {
  historyPeriods,
  type ClosedTrade,
  type Contract,
  type HistoryPeriod,
  type Portfolio,
  type PortfolioHistory,
  type PortfolioOrder,
  type PortfolioPosition,
  type PortfolioStop,
  type TradeFill,
} from "../../../packages/trading/src/portfolio.js";
import { shortRisks } from "../../../packages/trading/src/safety.js";
import type { BotPosition } from "./bot-store.js";

// The Bot trades tab for an account the site cannot read itself (IBKR, behind
// the Gateway on the private network): the same Portfolio and PortfolioHistory
// shapes the Alpaca tab shows, built from the broker and the bot's own records
// (docs/tasks/backend-bot-ibkr.md). The account may be shared with the owner's
// manual trades, so positions and orders are the bot's contracts only; the
// account totals are the whole account's.

const multiplier = 100; // option contracts
const periodDays: Record<HistoryPeriod, number> = {
  "1W": 7,
  "1M": 31,
  "3M": 92,
  "1A": 366,
};

function contract(symbol: string): Contract {
  try {
    const { underlying, ...option } = parseOccSymbol(symbol);
    return { symbol, underlying, option };
  } catch {
    return { symbol, underlying: symbol, option: null };
  }
}

/** The mid of a quote, else the side that is there; null without either. */
function mark(q: { bid: number; ask: number } | null): number | null {
  if (!q) return null;
  if (q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2;
  if (q.ask > 0) return q.ask;
  if (q.bid > 0) return q.bid;
  return null;
}

/** The stop orders covering a position, as the Portfolio tab shows them. */
function stopOf(
  symbol: string,
  qty: number,
  entry: number,
  orders: PortfolioOrder[],
): PortfolioStop | null {
  const stops = orders.filter(
    (o) => o.symbol === symbol && o.side === "sell" && o.stopPrice !== null,
  );
  if (stops.length === 0) return null;
  const covered = Math.min(
    qty,
    stops.reduce((sum, o) => sum + (o.qty - o.filledQty), 0),
  );
  // The highest stop is the one that fires first.
  const price = Math.max(...stops.map((o) => o.stopPrice!));
  return {
    price,
    qty: covered,
    lossPct: entry > 0 ? ((entry - price) / entry) * 100 : 0,
    risk: Math.max(0, (entry - price) * covered * multiplier),
  };
}

/** The bot's open positions at one account, with live marks, and its orders. */
export async function botPortfolio(
  broker: Broker,
  botPositions: readonly BotPosition[],
  now: number,
): Promise<Portfolio> {
  const mine = new Set(botPositions.map((p) => p.contract));
  const [account, open, held, marketOpen] = await Promise.all([
    broker.account(),
    broker.openOrders(),
    broker.positions(),
    broker.marketOpen().catch(() => false),
  ]);
  const orders: PortfolioOrder[] = open
    .filter((o) => mine.has(o.symbol))
    .map((o) => ({
      ...contract(o.symbol),
      id: o.id,
      side: o.side === "sell" ? "sell" : "buy",
      type: o.type ?? (o.stopPrice === null ? "limit" : "stop"),
      qty: o.qty,
      filledQty: o.filledQty,
      limitPrice: o.limitPrice,
      stopPrice: o.stopPrice,
      status: o.status,
      submittedAt: null,
    }));
  const positions: PortfolioPosition[] = await Promise.all(
    held
      .filter((p) => mine.has(p.symbol) && p.qty !== 0)
      .map(async (p) => {
        const quote = await broker.quote(p.symbol).catch(() => null);
        const price = mark(quote);
        const cost = p.avgEntryPrice * p.qty * multiplier;
        const value = price === null ? null : price * p.qty * multiplier;
        const pnl = value === null ? null : value - cost;
        return {
          ...contract(p.symbol),
          qty: p.qty,
          entry: p.avgEntryPrice,
          price,
          value,
          cost,
          pnl,
          pnlPct:
            price === null || p.avgEntryPrice <= 0
              ? null
              : (price / p.avgEntryPrice - 1) * 100,
          dayPnl: null,
          sharePct:
            value === null || account.equity <= 0
              ? null
              : (value / account.equity) * 100,
          underlyingPrice: null,
          underlyingPriceSource: null,
          delta: quote?.delta ?? null,
          gamma: null,
          theta: null,
          vega: null,
          impliedVolatility: quote?.iv ?? null,
          estimatedPrice: null,
          overnightPrice: null,
          estimateBreakdown: null,
          estimateAsOf: null,
          underlyingAsOf: null,
          marketDataIssue: quote ? null : "No quote from the broker",
          stop: stopOf(p.symbol, p.qty, p.avgEntryPrice, orders),
        };
      }),
  );
  const dayChange = account.equity - account.lastEquity;
  return {
    paper: broker.capabilities.paper,
    at: new Date(now).toISOString(),
    marketClosed: !marketOpen,
    account: {
      equity: account.equity,
      // IBKR reports what is free to spend, not a cash balance.
      cash: account.buyingPower,
      buyingPower: account.buyingPower,
      dayChange,
      dayChangePct:
        account.lastEquity > 0 ? (dayChange / account.lastEquity) * 100 : null,
    },
    overnightEstimate: null,
    positions,
    orders,
    riskAtStops: positions.reduce((sum, p) => sum + (p.stop?.risk ?? 0), 0),
    unprotected: positions.filter((p) => !p.stop || p.stop.qty < p.qty).length,
    // The whole account, as the owner's tab does: a short anywhere is a problem.
    shortRisks: shortRisks(held, open),
  };
}

/** A closed bot position as the tab's closed trade: its buy and each sale. */
function closedTrade(p: BotPosition): ClosedTrade {
  const priced = p.sales.filter(
    (s) => typeof s.price === "number" && s.qty > 0,
  );
  const sold = priced.reduce((sum, s) => sum + s.qty, 0);
  const proceeds = priced.reduce((sum, s) => sum + s.price! * s.qty, 0);
  const exit = sold > 0 ? proceeds / sold : 0;
  const pnl = priced.reduce(
    (sum, s) => sum + (s.price! - p.cost) * s.qty * multiplier,
    0,
  );
  const fills: TradeFill[] = [
    {
      side: "buy",
      at: new Date(p.openedAt).toISOString(),
      qty: p.bought,
      price: p.cost,
    },
    ...p.sales.map((s): TradeFill => ({
      side: "sell",
      at: new Date(s.at).toISOString(),
      qty: s.qty,
      price: s.price ?? 0,
    })),
  ];
  return {
    ...contract(p.contract),
    openedAt: new Date(p.openedAt).toISOString(),
    closedAt: new Date(p.closedAt ?? p.openedAt).toISOString(),
    qty: p.bought,
    entry: p.cost,
    exit,
    pnl,
    pnlPct: exit > 0 && p.cost > 0 ? (exit / p.cost - 1) * 100 : null,
    expired: false,
    fills,
  };
}

/**
 * The tab's history for one account: the recorded daily values in the period
 * and the bot's positions closed in it, newest first.
 */
export function botHistory(
  days: readonly { date: string; equity: number }[],
  positions: readonly BotPosition[],
  period: unknown,
  paper: boolean,
  now: number,
): { status: number; body: PortfolioHistory | { error: string } } {
  const chosen = period === undefined || period === "" ? "1M" : period;
  if (!historyPeriods.includes(chosen as HistoryPeriod))
    return {
      status: 400,
      body: { error: `period must be one of ${historyPeriods.join(", ")}` },
    };
  const p = chosen as HistoryPeriod;
  const from = newYork(now - periodDays[p] * 86_400_000).date;
  const inPeriod = days.filter((d) => d.date >= from && d.equity > 0);
  const base = inPeriod[0]?.equity ?? null;
  const points = inPeriod.map((d) => ({
    date: d.date,
    equity: d.equity,
    pnl: d.equity - (base ?? d.equity),
  }));
  const trades = positions
    .filter(
      (x) =>
        x.status === "closed" &&
        !x.dry &&
        x.closedAt !== null &&
        newYork(x.closedAt).date >= from,
    )
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .map(closedTrade);
  const pnl = points.at(-1)?.pnl ?? 0;
  return {
    status: 200,
    body: {
      from,
      baseEquity: base,
      paper,
      at: new Date(now).toISOString(),
      period: p,
      points,
      pnl,
      pnlPct: base ? (pnl / base) * 100 : null,
      trades,
      realized: trades.reduce((sum, t) => sum + t.pnl, 0),
      wins: trades.filter((t) => t.pnl > 0).length,
      activityLimit: 0,
      truncated: false,
    },
  };
}
