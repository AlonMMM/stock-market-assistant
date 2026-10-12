import { newYorkToUtc } from "../../market-data/src/calendar.js";
import {
  maxSizePct,
  maxSpreadRatio,
  maxStopPct,
  parseOccSymbol,
  spreadCheck,
  tick,
  type OptionQuote,
} from "./options.js";
import type { RiskVerdict } from "./risk-manager.js";

// Every check a buy must pass before any order is sent
// (docs/tasks/backend-trading-service.md, "Checks before a buy"). The buy is
// one step, with no preview in between, so these decide alone whether an
// order is good. They only allow or refuse; they never change the order.
// Selling and setting a stop are not subject to them.

export interface BuyLimits {
  maxSizePct: number;
  maxStopPct: number;
  maxSpreadRatio: number;
  // Different buys per New York trading day; sells are not counted
  // (user-confirmed 2026-10-11).
  maxBuysPerDay: number;
  // Risk at the stops of all open positions plus the new one, % of equity
  // (user-confirmed 2026-10-11).
  maxOpenRiskPct: number;
  // No new buy while equity is this far below the previous close
  // (user-confirmed 2026-10-11).
  maxDayLossPct: number;
  // The most one position may cost, % of equity: what is held of the same
  // stock and side, plus the new order (user 2026-10-12). A buy may add to an
  // open position up to this.
  maxPositionPct: number;
  // PROPOSED values below, not yet confirmed by the user.
  maxQuoteAgeMs: number;
  repeatMs: number; // a second buy of the same underlying and right
  lastMinutes: number; // of a contract's life
  requireMarketOpen: boolean;
  requireStops: boolean; // no buy while a held contract lacks a full stop
  requireDeltaInRange: boolean;
}

export const defaultBuyLimits: BuyLimits = {
  maxSizePct,
  maxStopPct,
  maxSpreadRatio,
  maxBuysPerDay: 10,
  maxOpenRiskPct: 10,
  maxDayLossPct: 5,
  maxPositionPct: 5,
  maxQuoteAgeMs: 120_000,
  repeatMs: 60_000,
  lastMinutes: 15,
  // Off-hours orders are allowed and wait for the open (user 2026-10-11).
  requireMarketOpen: false,
  requireStops: true,
  // The nearest expiry often has no strike inside the range; the closest
  // strike is bought and the miss is noted, as before the checks existed.
  requireDeltaInRange: false,
};

export interface HeldPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  stopQty: number; // contracts covered by open stop orders
  stopPrice: number | null; // the lowest of them
}

export interface BuyContext {
  now: number;
  enabled: boolean; // the kill switch and the user's own switch
  paper: boolean;
  shortRisks: string[];
  marketOpen: boolean;
  equity: number;
  lastEquity: number; // at the previous close
  buyingPower: number;
  positions: HeldPosition[];
  // Earlier buys of this trading day that filled or are still working.
  buysToday: { symbol: string; at: number }[];
  // Open buy orders: what they can still fill counts toward a position.
  working?: { symbol: string; qty: number; price: number }[];
  order: {
    quote: OptionQuote;
    qty: number;
    ceiling: number; // the most one contract can cost
    sizePct: number;
    stopPct: number;
    // A forced buy: the spread is not checked (user 2026-10-12).
    force?: boolean;
    // Set when the strike was picked from a range and not from a target.
    deltaRange?: readonly [number, number];
  };
  risk: RiskVerdict;
}

export interface CheckResult {
  check: string;
  ok: boolean;
  detail: string;
}

export interface BuyVerdict {
  ok: boolean;
  checks: CheckResult[];
  refused: string[]; // "check: detail" of each failed check
  // Things the user must be told that do not stop the order.
  notes: string[];
}

const pct = (n: number) => `${Number(n.toFixed(2))}%`;
const money = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/** $ lost if every open position is sold at its stop; no stop counts in full. */
export function openRisk(positions: HeldPosition[]): number {
  return positions
    .filter((p) => p.qty > 0)
    .reduce((sum, p) => {
      const covered = Math.min(p.stopQty, p.qty);
      const atStop =
        p.stopPrice === null
          ? 0
          : Math.max(p.avgEntryPrice - p.stopPrice, 0) * covered;
      const bare =
        (p.qty - (p.stopPrice === null ? 0 : covered)) * p.avgEntryPrice;
      return sum + (atStop + bare) * 100;
    }, 0);
}

export function checkBuy(
  c: BuyContext,
  limits: BuyLimits = defaultBuyLimits,
): BuyVerdict {
  const checks: CheckResult[] = [];
  const notes: string[] = [];
  const add = (check: string, ok: boolean, detail: string) =>
    checks.push({ check, ok, detail });
  const { quote, qty, ceiling, sizePct, stopPct } = c.order;
  const contract = parseOccSymbol(quote.symbol);

  // Account-level.
  add(
    "trading switched on",
    c.enabled,
    c.enabled ? "on" : "trading is switched off",
  );
  add(
    "paper account",
    c.paper,
    c.paper ? "paper" : "the live account is not authorized",
  );
  add(
    "no short risk",
    c.shortRisks.length === 0,
    c.shortRisks.length === 0 ? "none" : c.shortRisks.join("; "),
  );
  if (limits.requireMarketOpen)
    add(
      "market open",
      c.marketOpen,
      c.marketOpen ? "open" : "the market is closed",
    );
  else if (!c.marketOpen)
    notes.push(
      "off hours: the market is closed; the order waits at the broker and is worked when the market opens",
    );
  add(
    "buys per day",
    c.buysToday.length < limits.maxBuysPerDay,
    `${c.buysToday.length} of ${limits.maxBuysPerDay} used today`,
  );
  const dayLossPct =
    c.lastEquity > 0 ? ((c.lastEquity - c.equity) / c.lastEquity) * 100 : 0;
  add(
    "day loss",
    dayLossPct <= limits.maxDayLossPct,
    `the account is ${pct(Math.abs(dayLossPct))} ${dayLossPct > 0 ? "down" : "up"} today; no buys beyond ${limits.maxDayLossPct}% down`,
  );
  const tradeRisk = (ceiling * qty * 100 * stopPct) / 100;
  const risk = openRisk(c.positions) + tradeRisk;
  const riskLimit = (c.equity * limits.maxOpenRiskPct) / 100;
  add(
    "risk at the same time",
    risk <= riskLimit + 1e-9,
    `${money(risk)} at risk with this trade; the limit is ${limits.maxOpenRiskPct}% of the account, ${money(riskLimit)}`,
  );
  if (limits.requireStops) {
    const bare = c.positions.filter((p) => p.qty > 0 && p.stopQty < p.qty);
    add(
      "positions without a stop",
      bare.length === 0,
      bare.length === 0
        ? "every position has its stop"
        : `no full stop on ${bare.map((p) => p.symbol).join(", ")}`,
    );
  }
  const cost = ceiling * qty * 100;
  // One position is every contract of the same stock and side.
  const sameSide = (symbol: string) => {
    const other = parseOccSymbol(symbol);
    return (
      other.underlying === contract.underlying && other.right === contract.right
    );
  };
  const heldCost =
    c.positions
      .filter((p) => p.qty > 0 && sameSide(p.symbol))
      .reduce((sum, p) => sum + p.qty * p.avgEntryPrice * 100, 0) +
    (c.working ?? [])
      .filter((o) => sameSide(o.symbol))
      .reduce((sum, o) => sum + o.qty * o.price * 100, 0);
  const positionLimit = (c.equity * limits.maxPositionPct) / 100;
  const side = `${contract.underlying} ${contract.right}s`;
  add(
    "position size",
    heldCost + cost <= positionLimit + 1e-9,
    heldCost === 0
      ? `${money(cost)} in ${side}, at most ${limits.maxPositionPct}% of the account, ${money(positionLimit)}`
      : `${money(heldCost)} already in ${side} plus ${money(cost)} is ${pct(c.equity > 0 ? ((heldCost + cost) / c.equity) * 100 : 0)} of the account; one position may be at most ${limits.maxPositionPct}%, ${money(positionLimit)}, so ${money(Math.max(positionLimit - heldCost, 0))} more fits`,
  );
  add(
    "buying power",
    cost <= c.buyingPower + 1e-9,
    `needs ${money(cost)}, ${money(c.buyingPower)} available`,
  );
  add(
    "risk manager",
    c.risk.ok,
    c.risk.ok
      ? `${c.risk.account.state}: ${money(c.risk.tradeRisk)} of ${money(c.risk.tradeLimit)} per trade, ${money(c.risk.dayRisk)} of ${money(c.risk.dayLimit)} per day`
      : c.risk.reasons.join("; "),
  );

  // Order-level.
  add(
    "size",
    sizePct > 0 && sizePct <= limits.maxSizePct && qty >= 1,
    !(sizePct > 0 && sizePct <= limits.maxSizePct)
      ? `size ${sizePct}% is outside 0–${limits.maxSizePct}% of the account`
      : qty >= 1
        ? `${qty} contract${qty === 1 ? "" : "s"}, at most ${money(cost)}`
        : `${sizePct}% of the account buys no contract at ${ceiling.toFixed(2)}`,
  );
  const stopAt = ceiling * (1 - stopPct / 100);
  add(
    "stop",
    stopPct > 0 &&
      stopPct <= limits.maxStopPct &&
      stopAt >= tick(ceiling) - 1e-9,
    !(stopPct > 0 && stopPct <= limits.maxStopPct)
      ? `stop ${stopPct}% is outside 0–${limits.maxStopPct}% of the premium`
      : stopAt >= tick(ceiling) - 1e-9
        ? `${stopPct}% of the premium`
        : `the premium ${ceiling.toFixed(2)} is too small for a stop price`,
  );
  const usable = quote.bid > 0 && quote.ask > quote.bid;
  // While the market is closed every quote is old; its age is not held
  // against an order that waits for the open.
  const age =
    quote.quotedAt === undefined || !c.marketOpen
      ? null
      : c.now - quote.quotedAt;
  add(
    "quote is usable",
    usable && (age === null || age <= limits.maxQuoteAgeMs),
    !usable
      ? `bid ${quote.bid}, ask ${quote.ask}`
      : age === null
        ? c.marketOpen
          ? "the broker gave no quote time"
          : "the last quote before the close"
        : `${Math.max(0, Math.round(age / 1000))} s old, at most ${limits.maxQuoteAgeMs / 1000} s`,
  );
  const spread = spreadCheck(quote);
  const spreadOk = usable && spread.ratio <= limits.maxSpreadRatio + 1e-9;
  add(
    "spread",
    spreadOk || c.order.force === true,
    `${pct(spread.ratio * 100)} of the mid, at most ${pct(limits.maxSpreadRatio * 100)}${c.order.force && !spreadOk ? "; not checked, the buy is forced" : ""}`,
  );
  if (c.order.force && !spreadOk)
    notes.push(
      `forced: the spread is ${pct(spread.ratio * 100)} of the mid, above the ${pct(limits.maxSpreadRatio * 100)} limit, and was not checked`,
    );
  if (c.order.deltaRange) {
    const [low, high] = c.order.deltaRange;
    const d = quote.delta === null ? null : Math.abs(quote.delta);
    const inRange = d !== null && d >= low - 1e-9 && d <= high + 1e-9;
    const detail = `delta ${d === null ? "unknown" : d.toFixed(3)}, wanted ${low.toFixed(2)}–${high.toFixed(2)}`;
    if (limits.requireDeltaInRange) add("delta in range", inRange, detail);
    else if (!inRange)
      notes.push(`delta: no strike of this expiry is in the range; ${detail}`);
  }
  const same = c.buysToday.filter((b) => {
    const other = parseOccSymbol(b.symbol);
    return (
      other.underlying === contract.underlying &&
      other.right === contract.right &&
      c.now - b.at < limits.repeatMs
    );
  });
  add(
    "not a repeat",
    same.length === 0,
    same.length === 0
      ? "no recent buy of the same kind"
      : `${contract.underlying} ${contract.right}s were bought ${Math.round((c.now - same[0]!.at) / 1000)} s ago`,
  );
  // Options stop trading at 16:00 New York on their last day.
  const lastTrade = newYorkToUtc(contract.expiry, 16 * 60);
  const minutesLeft = (lastTrade - c.now) / 60000;
  add(
    "contract not expiring",
    minutesLeft > limits.lastMinutes,
    minutesLeft > limits.lastMinutes
      ? `expires ${contract.expiry}`
      : `it stops trading in ${Math.max(0, Math.round(minutesLeft))} minutes`,
  );

  const refused = checks
    .filter((r) => !r.ok)
    .map((r) => `${r.check}: ${r.detail}`);
  return { ok: refused.length === 0, checks, refused, notes };
}
