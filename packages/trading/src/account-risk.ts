import type { BuyLimits } from "./checks.js";
import type { RiskRules } from "./risk-manager.js";

// The owner's risk numbers for one account (user 2026-10-26: "risk manager
// should have ui config to configure the numbers, per account/bot; by default
// up to 5% losing day"). They replace the matching buy limits and risk
// manager rules of that account's trader; everything else (the 3% size cap,
// the stop cap, quote age, never short) stays as the code sets it.

export interface AccountRisk {
  // Today's loss plus the new trade's risk at its stop, % of the account, at
  // full; the account's day loss alone past this also refuses new buys.
  dayLossPct: number;
  // One trade's risk at its stop, % of the account, at full.
  tradeRiskPct: number;
  // The risk at the stops of every open position plus the new one.
  openRiskPct: number;
  // The most one position (one stock and side) may cost.
  maxPositionPct: number;
  buysPerDay: number;
  // A fall this far below the account's high puts the brake on.
  drawdownPct: number;
  // Trade and day limits under the brake and in recovery.
  brake: { trade: number; day: number };
  recovery: { trade: number; day: number };
}

export const defaultAccountRisk: AccountRisk = {
  dayLossPct: 5,
  tradeRiskPct: 5,
  openRiskPct: 10,
  maxPositionPct: 5,
  buysPerDay: 10,
  drawdownPct: 12.5,
  brake: { trade: 2, day: 3 },
  recovery: { trade: 3, day: 5 },
};

// [min, max] of each number; the page shows them and the service refuses others.
export const accountRiskBounds = {
  dayLossPct: [0.5, 25],
  tradeRiskPct: [0.25, 10],
  openRiskPct: [1, 50],
  maxPositionPct: [0.5, 25],
  buysPerDay: [1, 100],
  drawdownPct: [2, 50],
  trade: [0.25, 10],
  day: [0.5, 25],
} as const;

/** The account's settings over the defaults: a saved record may lack newer fields. */
export function withDefaults(saved: Partial<AccountRisk> | null): AccountRisk {
  return {
    ...defaultAccountRisk,
    ...(saved ?? {}),
    brake: { ...defaultAccountRisk.brake, ...(saved?.brake ?? {}) },
    recovery: { ...defaultAccountRisk.recovery, ...(saved?.recovery ?? {}) },
  };
}

/** The buy limits and risk manager rules with the account's numbers in them. */
export function applyAccountRisk(
  limits: BuyLimits,
  rules: RiskRules,
  risk: AccountRisk,
): { limits: BuyLimits; riskRules: RiskRules } {
  return {
    limits: {
      ...limits,
      maxDayLossPct: risk.dayLossPct,
      maxOpenRiskPct: risk.openRiskPct,
      maxPositionPct: risk.maxPositionPct,
      maxBuysPerDay: risk.buysPerDay,
    },
    riskRules: {
      ...rules,
      drawdownPct: risk.drawdownPct,
      limits: {
        full: { trade: risk.tradeRiskPct, day: risk.dayLossPct },
        brake: { ...risk.brake },
        recovery: { ...risk.recovery },
      },
    },
  };
}

/** A whole settings record from the page, or the words of what is wrong. */
export function parseAccountRisk(value: unknown): AccountRisk | string {
  if (!value || typeof value !== "object") return "Expected the risk settings";
  const v = value as Record<string, unknown>;
  const errors: string[] = [];
  const num = (
    raw: unknown,
    name: string,
    [lo, hi]: readonly [number, number],
  ): number => {
    const n = typeof raw === "number" ? raw : Number.NaN;
    if (!Number.isFinite(n) || n < lo || n > hi) {
      errors.push(`${name} must be from ${lo} to ${hi}`);
      return 0;
    }
    return n;
  };
  const pair = (raw: unknown, name: string) => {
    const p = (raw && typeof raw === "object" ? raw : {}) as Record<
      string,
      unknown
    >;
    return {
      trade: num(p.trade, `${name} trade limit`, accountRiskBounds.trade),
      day: num(p.day, `${name} day limit`, accountRiskBounds.day),
    };
  };
  const b = accountRiskBounds;
  const risk: AccountRisk = {
    dayLossPct: num(v.dayLossPct, "The daily loss limit", b.dayLossPct),
    tradeRiskPct: num(v.tradeRiskPct, "The risk per trade", b.tradeRiskPct),
    openRiskPct: num(v.openRiskPct, "The open risk limit", b.openRiskPct),
    maxPositionPct: num(
      v.maxPositionPct,
      "The largest position",
      b.maxPositionPct,
    ),
    buysPerDay: num(v.buysPerDay, "Buys per day", b.buysPerDay),
    drawdownPct: num(v.drawdownPct, "The brake's drawdown", b.drawdownPct),
    brake: pair(v.brake, "The brake's"),
    recovery: pair(v.recovery, "Recovery's"),
  };
  if (!Number.isInteger(risk.buysPerDay) && errors.length === 0)
    errors.push("Buys per day must be a whole number");
  return errors.length ? errors.join("; ") : risk;
}
