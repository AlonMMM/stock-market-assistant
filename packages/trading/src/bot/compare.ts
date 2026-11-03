import type { BotBroker } from "./settings.js";

// Alpaca against IBKR as two bots on the same signals (the owner, 2026-11-03:
// "this is kind of benchmark. i would like to see how ibkr is against
// alpaca"). Each account reads its own chain, picks its own contract and
// fills on its own; this sets the two legs of every signal side by side, per
// day and in total. Only signals that went to both accounts count.

export interface CompareLeg {
  broker: BotBroker;
  outcome: string;
  detail: string;
  contract?: string;
  pickMs?: number;
  book?: { bid: number; ask: number; mid: number };
  positionId?: string;
  cross?: { contract: string; book: { bid: number; ask: number } };
}

export interface CompareSignal {
  day: string;
  symbol: string;
  at: number; // ms, when the signal came
  legs?: CompareLeg[];
}

export interface ComparePosition {
  id: string;
  broker?: BotBroker;
  addOf?: string;
  cost: number;
  bought: number;
  status: "buying" | "open" | "closed";
  sales: { qty: number; price?: number }[];
  filledAt?: number;
}

export interface LegStats {
  taken: number; // signals this account bought
  pickMs: number | null; // median: the chain, the pick and the volume read
  fillMs: number | null; // median: from the signal to the fill
  open: number; // entries not closed yet
  closed: number; // entries closed with every sale priced
  pnlUsd: number; // the closed entries' result, adds included
  pnlPct: number | null; // ... as a share of what they cost, in %
}

export interface CompareRow {
  day: string; // a date, or "total"
  signals: number; // signals that went to both accounts
  same: number; // both picked a contract, the same one
  different: number; // both picked a contract, different ones
  // Median of IBKR's fill against Alpaca's on the same contract, % of Alpaca's.
  fillGapPct: number | null;
  // Median of IBKR's mid against Alpaca's on one contract at the pick (the
  // same pick, or each account's quote of the other's), % of Alpaca's.
  quoteGapPct: number | null;
  alpaca: LegStats;
  ibkr: LegStats;
}

/** A signal one account bought and the other did not, with the other's reason. */
export interface OneSided {
  day: string;
  symbol: string;
  took: BotBroker;
  missed: BotBroker;
  outcome: string;
  detail: string;
}

export interface BotCompare {
  days: CompareRow[]; // newest first
  total: CompareRow;
  oneSided: OneSided[]; // newest first
}

const entered = (outcome: string) =>
  outcome === "bought" || outcome === "would-buy";

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const gapPct = (ibkr: number, alpaca: number) =>
  alpaca > 0 ? ((ibkr - alpaca) / alpaca) * 100 : null;

/** A position's result and cost when it is closed and every sale has a price. */
function result(p: ComparePosition): { pnl: number; cost: number } | null {
  if (p.status !== "closed" || p.bought <= 0) return null;
  if (p.sales.some((s) => s.qty > 0 && typeof s.price !== "number"))
    return null;
  const pnl = p.sales.reduce(
    (sum, s) => sum + ((s.price ?? p.cost) - p.cost) * s.qty * 100,
    0,
  );
  return { pnl, cost: p.cost * p.bought * 100 };
}

interface Tally {
  taken: number;
  pickMs: number[];
  fillMs: number[];
  open: number;
  closed: number;
  pnl: number;
  cost: number;
}

const tally = (): Tally => ({
  taken: 0,
  pickMs: [],
  fillMs: [],
  open: 0,
  closed: 0,
  pnl: 0,
  cost: 0,
});

function stats(t: Tally): LegStats {
  return {
    taken: t.taken,
    pickMs: median(t.pickMs),
    fillMs: median(t.fillMs),
    open: t.open,
    closed: t.closed,
    pnlUsd: Math.round(t.pnl * 100) / 100,
    pnlPct: t.cost > 0 ? Math.round((t.pnl / t.cost) * 1000) / 10 : null,
  };
}

interface Bucket {
  signals: number;
  same: number;
  different: number;
  fillGaps: number[];
  quoteGaps: number[];
  legs: Record<BotBroker, Tally>;
}

const bucket = (): Bucket => ({
  signals: 0,
  same: 0,
  different: 0,
  fillGaps: [],
  quoteGaps: [],
  legs: { alpaca: tally(), ibkr: tally() },
});

function row(day: string, b: Bucket): CompareRow {
  const round = (v: number | null) =>
    v === null ? null : Math.round(v * 10) / 10;
  return {
    day,
    signals: b.signals,
    same: b.same,
    different: b.different,
    fillGapPct: round(median(b.fillGaps)),
    quoteGapPct: round(median(b.quoteGaps)),
    alpaca: stats(b.legs.alpaca),
    ibkr: stats(b.legs.ibkr),
  };
}

/** The two accounts' legs side by side, per day and in total. */
export function compareLegs(
  signals: readonly CompareSignal[],
  positions: readonly ComparePosition[],
): BotCompare {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const adds = new Map<string, ComparePosition[]>();
  for (const p of positions)
    if (p.addOf) adds.set(p.addOf, [...(adds.get(p.addOf) ?? []), p]);
  const days = new Map<string, Bucket>();
  const total = bucket();
  const oneSided: OneSided[] = [];
  for (const s of signals) {
    const alpaca = s.legs?.find((l) => l.broker === "alpaca");
    const ibkr = s.legs?.find((l) => l.broker === "ibkr");
    if (!alpaca || !ibkr) continue;
    let day = days.get(s.day);
    if (!day) days.set(s.day, (day = bucket()));
    const into = [day, total];
    for (const b of into) b.signals++;
    if (alpaca.contract && ibkr.contract) {
      const same = alpaca.contract === ibkr.contract;
      for (const b of into) {
        if (same) b.same++;
        else b.different++;
      }
      const gaps: (number | null)[] = [];
      if (same && alpaca.book && ibkr.book)
        gaps.push(gapPct(ibkr.book.mid, alpaca.book.mid));
      // Each account's quote of the other's contract: the same contract, two brokers.
      if (!same && ibkr.book && alpaca.cross)
        gaps.push(gapPct(ibkr.book.mid, midOf(alpaca.cross.book)));
      if (!same && alpaca.book && ibkr.cross)
        gaps.push(gapPct(midOf(ibkr.cross.book), alpaca.book.mid));
      for (const g of gaps)
        if (g !== null) for (const b of into) b.quoteGaps.push(g);
    }
    const fills: Partial<Record<BotBroker, number>> = {};
    for (const leg of [alpaca, ibkr]) {
      if (typeof leg.pickMs === "number")
        for (const b of into) b.legs[leg.broker].pickMs.push(leg.pickMs);
      if (!entered(leg.outcome)) continue;
      for (const b of into) b.legs[leg.broker].taken++;
      const p = leg.positionId ? byId.get(leg.positionId) : undefined;
      if (!p) continue;
      if (p.status !== "buying" && p.bought > 0) fills[leg.broker] = p.cost;
      if (typeof p.filledAt === "number")
        for (const b of into) b.legs[leg.broker].fillMs.push(p.filledAt - s.at);
      const parts = [p, ...(adds.get(p.id) ?? [])];
      const done = parts.map(result);
      const open = done.some((d) => d === null);
      for (const b of into) {
        const t = b.legs[leg.broker];
        if (open) {
          t.open++;
          continue;
        }
        t.closed++;
        for (const d of done) {
          t.pnl += d!.pnl;
          t.cost += d!.cost;
        }
      }
    }
    if (
      alpaca.contract &&
      alpaca.contract === ibkr.contract &&
      fills.alpaca !== undefined &&
      fills.ibkr !== undefined
    ) {
      const g = gapPct(fills.ibkr, fills.alpaca);
      if (g !== null) for (const b of into) b.fillGaps.push(g);
    }
    const tookA = entered(alpaca.outcome);
    const tookI = entered(ibkr.outcome);
    if (tookA !== tookI) {
      const missed = tookA ? ibkr : alpaca;
      oneSided.push({
        day: s.day,
        symbol: s.symbol,
        took: tookA ? "alpaca" : "ibkr",
        missed: missed.broker,
        outcome: missed.outcome,
        detail: missed.detail,
      });
    }
  }
  return {
    days: [...days]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([day, b]) => row(day, b)),
    total: row("total", total),
    oneSided: oneSided.reverse(),
  };
}

const midOf = (b: { bid: number; ask: number }) => (b.bid + b.ask) / 2;
