// The risk manager (user decision, 2026-10-11): @ultrawavetrader's own rules,
// from docs/tasks/research-indi-2026.md, "Risk management". It only validates
// a new buy. It never changes an order: not its size, contract or stop.
// Design: docs/tasks/backend-trading-service.md.

export type RiskState = "full" | "brake" | "recovery";

export interface RiskRules {
  // Risk per trade and per day, as % of equity, by state of the account.
  limits: Record<RiskState, { trade: number; day: number }>;
  // A fall this far below the high puts the brake on.
  drawdownPct: number;
  // The brake comes off once this share of the fall is recovered…
  recoverShare: number;
  // …and goes back on when this share of that recovery is lost again.
  giveBackShare: number;
  // Days in a row that hit the daily limit, which also put the brake on.
  dailyStopsInARow: number;
}

export const defaultRiskRules: RiskRules = {
  limits: {
    full: { trade: 5, day: 7 },
    brake: { trade: 2, day: 3 },
    recovery: { trade: 3, day: 5 },
  },
  drawdownPct: 12.5,
  recoverShare: 2 / 3,
  giveBackShare: 1 / 2,
  dailyStopsInARow: 2,
};

/**
 * The share of a premium he counts as lost, by calendar days to expiry. The
 * source gives a month (50%), a week (70%), 5/4/3/2 days (75/80/85/90%) and
 * 4 hours or less (100%). PROPOSED fill-ins: 6 to 29 days use 70%, and a day
 * or less uses 100%.
 */
export function lossShare(daysToExpiry: number): number {
  if (daysToExpiry >= 30) return 0.5;
  if (daysToExpiry >= 6) return 0.7;
  if (daysToExpiry >= 5) return 0.75;
  if (daysToExpiry >= 4) return 0.8;
  if (daysToExpiry >= 3) return 0.85;
  if (daysToExpiry >= 2) return 0.9;
  return 1;
}

export interface EquityDay {
  date: string;
  equity: number; // at the close
}

export interface AccountState {
  state: RiskState;
  peak: number;
  drawdownPct: number; // of the last close below the high
  reason: string;
}

/**
 * The state of the account after the last day of `history` (oldest first).
 * A day "hit the daily limit" when the account lost at least the per-day
 * limit of the state it was in. That is measured on the whole account, an
 * approximation of his rule, which counts only that day's trades.
 */
export function accountState(
  history: EquityDay[],
  rules: RiskRules = defaultRiskRules,
): AccountState {
  const days = history.filter((d) => d.equity > 0);
  let state: RiskState = "full";
  let reason = "no history";
  let peak = days[0]?.equity ?? 0;
  let trough = peak;
  let high = peak; // the best close since the brake came off
  let stops = 0;
  let last = peak;
  const brake = (equity: number, why: string) => {
    state = "brake";
    trough = Math.min(trough, equity);
    reason = why;
  };
  for (const [i, day] of days.entries()) {
    const e = day.equity;
    if (i > 0) {
      const lossPct = ((last - e) / last) * 100;
      stops = lossPct >= rules.limits[state].day ? stops + 1 : 0;
    }
    last = e;
    if (e >= peak) {
      peak = e;
      trough = e;
      state = "full";
      reason = "at a new high";
      continue;
    }
    const twoStops = stops >= rules.dailyStopsInARow;
    const was = state as RiskState;
    if (was === "full") {
      trough = e;
      if (((peak - e) / peak) * 100 >= rules.drawdownPct)
        brake(e, `${rules.drawdownPct}% below the high`);
      else if (twoStops)
        brake(e, `${rules.dailyStopsInARow} days in a row at the daily limit`);
      else reason = "above the drawdown limit";
    } else if (was === "brake") {
      trough = Math.min(trough, e);
      if (e >= trough + rules.recoverShare * (peak - trough)) {
        state = "recovery";
        high = e;
        reason = "most of the fall recovered";
      }
    } else {
      high = Math.max(high, e);
      if (e <= high - rules.giveBackShare * (high - trough))
        brake(e, "half of the recovery lost again");
      else if (twoStops)
        brake(e, `${rules.dailyStopsInARow} days in a row at the daily limit`);
    }
  }
  return {
    state,
    peak,
    drawdownPct: peak > 0 ? ((peak - last) / peak) * 100 : 0,
    reason,
  };
}

export interface RiskRequest {
  history: EquityDay[]; // daily closes before today, oldest first
  equity: number; // now
  todayLoss: number; // $ lost so far on today's trades; 0 when ahead
  premium: number; // $ the new order can cost
  daysToExpiry: number; // calendar days
  // The order's stop, % of the premium: its risk is counted at the stop
  // (user 2026-10-26: "our default stop is 50%"). Without one, the share he
  // counts as lost by days to expiry (lossShare).
  stopPct?: number;
}

export interface RiskVerdict {
  ok: boolean;
  reasons: string[]; // why it was refused; empty when ok
  account: AccountState;
  sharePct: number; // of the premium counted as at risk
  tradeRisk: number; // $
  tradeLimit: number; // $
  dayRisk: number; // $ today's loss plus this order's risk
  dayLimit: number; // $
}

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/** Whether a new buy is within the risk manager's limits. */
export function checkRisk(
  request: RiskRequest,
  rules: RiskRules = defaultRiskRules,
): RiskVerdict {
  const account = accountState(request.history, rules);
  const limits = rules.limits[account.state];
  const atStop = request.stopPct !== undefined && request.stopPct > 0;
  const share = atStop
    ? Math.min(request.stopPct! / 100, 1)
    : lossShare(request.daysToExpiry);
  const tradeRisk = request.premium * share;
  const tradeLimit = (request.equity * limits.trade) / 100;
  const dayRisk = Math.max(request.todayLoss, 0) + tradeRisk;
  const dayLimit = (request.equity * limits.day) / 100;
  const reasons: string[] = [];
  if (tradeRisk > tradeLimit + 1e-9)
    reasons.push(
      `Risk manager (${account.state}): this trade risks ${money(tradeRisk)}, ${Math.round(share * 100)}% of its premium${atStop ? " at its stop" : ""}; the limit per trade is ${limits.trade}% of the account, ${money(tradeLimit)}`,
    );
  if (dayRisk > dayLimit + 1e-9)
    reasons.push(
      `Risk manager (${account.state}): today's loss plus this trade's risk is ${money(dayRisk)}; the limit per day is ${limits.day}% of the account, ${money(dayLimit)}`,
    );
  return {
    ok: reasons.length === 0,
    reasons,
    account,
    sharePct: share * 100,
    tradeRisk,
    tradeLimit,
    dayRisk,
    dayLimit,
  };
}
