import {
  defaultBuyLimits,
  type BuyContext,
  type BuyLimits,
  type CheckResult,
} from "./checks.js";
import { defaultRiskRules, type RiskRules } from "./risk-manager.js";

// Each trader's buy rules (docs/features/multi-user-ibkr.md, "Validators").
// A trader record points at one of these by id. They are code in Git,
// reviewed and tested; nothing is loaded from a path, a URL or an upload.
//
// A validator only adds rules. The engine's own checks run whatever the
// validator says: trading switched on, paper account, no short risk, and
// sells that can only close what is held.

export interface Validator {
  id: string;
  description: string;
  // The limits and risk rules `checkBuy` and the risk manager run with.
  limits: BuyLimits;
  riskRules: RiskRules;
  /** More checks on a buy; each failed one refuses it. */
  check?(c: BuyContext, params: Record<string, unknown>): CheckResult[];
}

const ownerV1: Validator = {
  id: "owner-v1",
  description:
    "The owner's rules as of 2026-10-17: the default buy limits and @ultrawavetrader's risk manager.",
  limits: defaultBuyLimits,
  riskRules: defaultRiskRules,
};

export const validators: ReadonlyMap<string, Validator> = new Map(
  [ownerV1].map((v) => [v.id, v]),
);

/** What the engine runs for one trader. */
export interface ResolvedValidator {
  id: string | null;
  limits: BuyLimits;
  riskRules: RiskRules;
  check: (c: BuyContext) => CheckResult[];
}

/**
 * The validator a trader points at. Without one, or with an id that is not
 * in the registry, the trader cannot buy (user 2026-10-17); selling and
 * stops still work.
 */
export function resolveValidator(
  id: string | null,
  params: Record<string, unknown> | null = null,
): ResolvedValidator {
  const found = id === null ? undefined : validators.get(id);
  if (!found)
    return {
      id,
      limits: defaultBuyLimits,
      riskRules: defaultRiskRules,
      check: () => [
        {
          check: "validator",
          ok: false,
          detail:
            id === null
              ? "no validator is set for this trader, so buys are refused"
              : `validator "${id}" does not exist, so buys are refused`,
        },
      ],
    };
  return {
    id: found.id,
    limits: found.limits,
    riskRules: found.riskRules,
    check: (c) => found.check?.(c, params ?? {}) ?? [],
  };
}
