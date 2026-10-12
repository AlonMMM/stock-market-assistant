import type { CheckResult } from "./checks.js";
import {
  ceilingFraction,
  defaultDeltaRange,
  type OptionQuote,
} from "./options.js";
import type { RiskVerdict } from "./risk-manager.js";

// Why an order looks the way it does: what the command said, what came from
// a default, how the contract, price, size and stop were worked out, and the
// result of every check. One is recorded for every buy, refused ones too,
// and shown on the site (Portfolio → Orders).

export interface ExplainedInput {
  name: string;
  value: string;
  source: "command" | "default";
}

export interface ExplainedStrike {
  strike: number;
  delta: number | null;
  bid: number;
  ask: number;
  chosen: boolean;
}

export interface BuyExplanation {
  at: string; // ISO time of the decision
  paper: boolean;
  inputs: ExplainedInput[];
  contract: {
    symbol: string;
    underlying: string;
    expiry: string;
    right: string;
    strike: number;
    delta: number | null;
  };
  // Absent when the command named the exact contract.
  selection?: {
    offered: { expiry: string; label: string }[];
    expiryRule: string;
    strikeRule: string;
    strikes: ExplainedStrike[]; // the chosen strike and its neighbours
  };
  pricing: {
    bid: number;
    ask: number;
    mid: number;
    spreadPct: number;
    ceiling: number;
    rule: string;
  };
  sizing: {
    equity: number;
    sizePct: number;
    budget: number;
    qty: number;
    maxCost: number;
    rule: string;
  };
  stop: { pct: number; atCeiling: number | null; rule: string };
  risk: {
    state: string;
    reason: string;
    daysToExpiry: number;
    sharePct: number;
    tradeRisk: number;
    tradeLimit: number;
    dayRisk: number;
    dayLimit: number;
    ok: boolean;
  };
  offHours: boolean;
  checks: CheckResult[];
  notes: string[];
  refused: string[];
}

export type DecisionOutcome =
  | "refused" // a check failed: nothing was sent
  | "working" // sent, not finished
  | "filled"
  | "partly filled"
  | "not filled"
  | "failed";

/** One buy command and everything decided about it. */
export interface Decision {
  id: string;
  at: number;
  symbol: string;
  outcome: DecisionOutcome;
  explanation: BuyExplanation;
  // Set when the order finished.
  result?: {
    filledQty: number;
    avgPrice: number | null;
    stopPrice?: number;
    stopQty?: number;
    canceledQty?: number;
    error?: string;
  };
}

export interface DecisionLog {
  put(decision: Decision): Promise<void>;
}

const r2 = (n: number) => Number(n.toFixed(2));

export interface ExplainParts {
  now: number;
  paper: boolean;
  request: {
    contract?: string;
    underlying?: string;
    right?: string;
    sizePct: number;
    qty?: number; // an exact number of contracts was asked for
    expiry?: string;
    delta?: number;
    stopPct?: number;
  };
  defaultExpiry: string;
  atAsk?: boolean; // bought at the ask at once, not raised from the mid
  quote: OptionQuote;
  // Present when the engine picked the contract.
  chosen?: {
    rows: { expiry: string; label: string }[];
    expiry: string;
    candidates: OptionQuote[]; // the chosen expiry's chain
  };
  equity: number;
  ceiling: number;
  qty: number;
  budget: number;
  cost: number;
  stopPct: number;
  stopAtCeiling: number | null;
  daysToExpiry: number;
  risk: RiskVerdict;
  marketOpen: boolean;
  verdict: { checks: CheckResult[]; notes: string[]; refused: string[] };
}

export function explainBuy(p: ExplainParts): BuyExplanation {
  const { request, quote } = p;
  const [low, high] = defaultDeltaRange;
  const said = (value: unknown) => value !== undefined;
  const inputs: ExplainedInput[] = request.contract
    ? [{ name: "Contract", value: quote.symbol, source: "command" }]
    : [
        { name: "Stock", value: quote.underlying, source: "command" },
        {
          name: "Direction",
          value: quote.right === "call" ? "Call" : "Put",
          source: "command",
        },
        {
          name: "Expiry",
          value: said(request.expiry)
            ? `${request.expiry} → ${quote.expiry}`
            : `${p.defaultExpiry} → ${quote.expiry}`,
          source: said(request.expiry) ? "command" : "default",
        },
        {
          name: "Delta",
          value: said(request.delta)
            ? `closest to ${request.delta}`
            : `${low.toFixed(2)}–${high.toFixed(2)}`,
          source: said(request.delta) ? "command" : "default",
        },
      ];
  inputs.push(
    {
      name: "Size",
      value:
        request.qty === undefined
          ? `${request.sizePct}% of the account`
          : `${request.qty} contract${request.qty === 1 ? "" : "s"}, ${r2(request.sizePct)}% of the account`,
      source: "command",
    },
    {
      name: "Stop",
      value: `${p.stopPct}% of the premium`,
      source: said(request.stopPct) ? "command" : "default",
    },
  );
  const mid = (quote.bid + quote.ask) / 2;
  let selection: BuyExplanation["selection"];
  if (p.chosen) {
    const chain = p.chosen.candidates
      .filter((q) => q.delta !== null)
      .sort((a, b) => a.strike - b.strike);
    const at = chain.findIndex((q) => q.symbol === quote.symbol);
    selection = {
      offered: p.chosen.rows,
      expiryRule: said(request.expiry)
        ? `The command named the expiry (${request.expiry}).`
        : `No expiry in the command: the ${p.defaultExpiry} one is used.`,
      strikeRule: said(request.delta)
        ? `The strike whose delta is closest to ${request.delta}.`
        : `The strike whose delta is closest to the middle of ${low.toFixed(2)}–${high.toFixed(2)} (${((low + high) / 2).toFixed(3)}).`,
      strikes: (at < 0 ? [] : chain.slice(Math.max(0, at - 2), at + 3)).map(
        (q) => ({
          strike: q.strike,
          delta: q.delta,
          bid: q.bid,
          ask: q.ask,
          chosen: q.symbol === quote.symbol,
        }),
      ),
    };
  }
  return {
    at: new Date(p.now).toISOString(),
    paper: p.paper,
    inputs,
    contract: {
      symbol: quote.symbol,
      underlying: quote.underlying,
      expiry: quote.expiry,
      right: quote.right,
      strike: quote.strike,
      delta: quote.delta,
    },
    ...(selection ? { selection } : {}),
    pricing: {
      bid: quote.bid,
      ask: quote.ask,
      mid: Number(mid.toFixed(3)),
      spreadPct: mid > 0 ? r2(((quote.ask - quote.bid) / mid) * 100) : 0,
      ceiling: p.ceiling,
      rule: p.atAsk
        ? `The order is sent at the ask, ${p.ceiling.toFixed(2)}, and follows the ask up while it stays within the size.`
        : `The order starts at the mid and is raised at most to ${Math.round(ceilingFraction * 100)}% of the way from the mid to the ask, rounded down to a tick: ${p.ceiling.toFixed(2)}.`,
    },
    sizing: {
      equity: r2(p.equity),
      sizePct: request.sizePct,
      budget: r2(p.budget),
      qty: p.qty,
      maxCost: r2(p.cost),
      rule:
        request.qty !== undefined
          ? `${request.qty} contract${request.qty === 1 ? "" : "s"} asked for. One costs at most ${p.ceiling.toFixed(2)} × 100 = ${r2(p.ceiling * 100)}, so the order costs at most ${r2(p.cost)}: ${r2(request.sizePct)}% of ${Math.round(p.equity).toLocaleString("en-US")}.`
          : p.qty > 0
            ? `${request.sizePct}% of ${Math.round(p.equity).toLocaleString("en-US")} is ${r2(p.budget)}. One contract costs at most ${p.ceiling.toFixed(2)} × 100 = ${r2(p.ceiling * 100)}, so ${p.qty} whole contract${p.qty === 1 ? "" : "s"} fit${p.qty === 1 ? "s" : ""} (${r2(p.cost)}).`
            : "No whole contract fits this size.",
    },
    stop: {
      pct: p.stopPct,
      atCeiling: p.stopAtCeiling,
      rule: `A stop loss ${p.stopPct}% below the price paid${said(request.stopPct) ? "" : " (the default)"}, placed as each contract fills${p.stopAtCeiling === null ? "" : `. At the highest price that is ${p.stopAtCeiling.toFixed(2)}`}.`,
    },
    risk: {
      state: p.risk.account.state,
      reason: p.risk.account.reason,
      daysToExpiry: p.daysToExpiry,
      sharePct: p.risk.sharePct,
      tradeRisk: r2(p.risk.tradeRisk),
      tradeLimit: r2(p.risk.tradeLimit),
      dayRisk: r2(p.risk.dayRisk),
      dayLimit: r2(p.risk.dayLimit),
      ok: p.risk.ok,
    },
    offHours: !p.marketOpen,
    checks: p.verdict.checks,
    notes: p.verdict.notes,
    refused: p.verdict.refused,
  };
}
