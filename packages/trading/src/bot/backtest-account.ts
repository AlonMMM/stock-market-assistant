import type { SimStep, SimTrade } from "./backtest.js";

// The account over a backtest's trades (backtest.ts): every stock's trades in
// time order, each sized from the account, the bot's limits on buys a day and
// open positions, the overnight cap, and a fee per contract each way. Pure
// and quick, so the Backtest page applies new money settings without a new
// run. Whole contracts, as the bot buys them.

export interface MoneySettings {
  startEquity: number; // dollars
  sizePct: number; // of the account, per trade
  // The size is a share of the account at the start of the day (true), or of
  // the starting account always (false).
  compound: boolean;
  feePerContract: number; // dollars, each way
  maxBuysPerDay: number;
  maxOpen: number;
  nightCapPct: number; // 0 = no cap
  fillPct: number; // the run's fill cost, for the cap's sale
}

export const defaultMoney: MoneySettings = {
  startEquity: 100_000,
  sizePct: 2,
  compound: true,
  feePerContract: 0.62,
  maxBuysPerDay: 5,
  maxOpen: 4,
  nightCapPct: 10,
  fillPct: 2,
};

export type TradeStatus = "taken" | "day-limit" | "open-limit" | "too-small";

export interface Fill {
  date: string;
  minute: number;
  kind: "buy" | "sell" | "carry";
  qty: number;
  price: number;
  reason: SimStep["reason"] | "night-cap";
}

export interface AccountTrade {
  trade: SimTrade;
  status: TradeStatus;
  qty: number; // contracts bought
  paid: number; // dollars for the buy
  proceeds: number; // dollars from every sale
  fees: number;
  pnl: number; // proceeds - paid - fees
  retPct: number; // pnl / paid, %
  fills: Fill[];
  open: boolean; // valued at the last price, not sold
}

export interface AccountResult {
  trades: AccountTrade[]; // every signal bought, in entry order, the ones a limit refused too
  start: number;
  end: number;
  pnl: number;
  returnPct: number;
  taken: number;
  wins: number;
  losses: number;
  winRate: number; // %
  avgWin: number; // dollars
  avgLoss: number; // dollars, negative
  profitFactor: number | null; // gains / losses; null without a loss
  maxDrawdownPct: number; // the deepest fall of the end-of-day account from its high, %
  curve: { date: string; equity: number }[]; // the account at each day's end
  open: number; // trades still held when the data ended
}

interface Event {
  date: string;
  minute: number;
  rank: number; // at the same minute: sales and holds before buys, so a sale frees its slot
  trade: number;
  step: number;
}

export function runAccount(
  trades: readonly SimTrade[],
  money: MoneySettings,
): AccountResult {
  const events: Event[] = [];
  trades.forEach((t, i) =>
    t.steps.forEach((s, j) =>
      events.push({
        date: s.date,
        minute: s.minute,
        rank: s.kind === "buy" ? 1 : 0,
        trade: i,
        step: j,
      }),
    ),
  );
  events.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.minute - b.minute ||
      a.rank - b.rank ||
      a.trade - b.trade,
  );
  const out: AccountTrade[] = trades.map((trade) => ({
    trade,
    status: "taken",
    qty: 0,
    paid: 0,
    proceeds: 0,
    fees: 0,
    pnl: 0,
    retPct: 0,
    fills: [],
    open: trade.open,
  }));
  // Per trade: contracts held, and the factor later shares are scaled by after the cap.
  const held = new Array<number>(trades.length).fill(0);
  const factor = new Array<number>(trades.length).fill(1);
  const refused = new Set<number>();
  let equity = money.startEquity;
  let dayStart = equity;
  let day = "";
  let buysToday = 0;
  let openCount = 0;
  const curve: { date: string; equity: number }[] = [];
  const fee = (q: number) => q * money.feePerContract;
  const close = (i: number) => {
    const a = out[i]!;
    a.pnl = a.proceeds - a.paid - a.fees;
    a.retPct = a.paid ? (a.pnl / a.paid) * 100 : 0;
    equity += a.pnl;
    openCount--;
  };
  for (const e of events) {
    if (e.date !== day) {
      if (day) curve.push({ date: day, equity });
      day = e.date;
      dayStart = equity;
      buysToday = 0;
    }
    if (refused.has(e.trade)) continue;
    const t = trades[e.trade]!;
    const s = t.steps[e.step]!;
    const a = out[e.trade]!;
    if (s.kind === "buy") {
      if (buysToday >= money.maxBuysPerDay) {
        a.status = "day-limit";
        refused.add(e.trade);
        continue;
      }
      if (openCount >= money.maxOpen) {
        a.status = "open-limit";
        refused.add(e.trade);
        continue;
      }
      const basis = money.compound ? dayStart : money.startEquity;
      const budget = ((basis * money.sizePct) / 100) * t.sizeShare;
      const qty = Math.floor(budget / (s.price * 100));
      if (qty < 1) {
        a.status = "too-small";
        refused.add(e.trade);
        continue;
      }
      buysToday++;
      openCount++;
      a.qty = qty;
      held[e.trade] = qty;
      a.paid = qty * s.price * 100;
      a.fees += fee(qty);
      a.fills.push({
        date: s.date,
        minute: s.minute,
        kind: "buy",
        qty,
        price: s.price,
        reason: s.reason,
      });
      continue;
    }
    if (held[e.trade]! <= 0) continue;
    if (s.kind === "carry") {
      // The overnight cap: what is held tonight is worth at most nightCapPct of the account.
      if (money.nightCapPct > 0 && s.price > 0) {
        const cap = (equity * money.nightCapPct) / 100;
        const keep = Math.min(
          held[e.trade]!,
          Math.floor(cap / (s.price * 100)),
        );
        const sold = held[e.trade]! - keep;
        if (sold > 0) {
          const price = Math.max(s.price * (1 - money.fillPct / 100), 0.01);
          a.proceeds += sold * price * 100;
          a.fees += fee(sold);
          a.fills.push({
            date: s.date,
            minute: s.minute,
            kind: "sell",
            qty: sold,
            price,
            reason: "night-cap",
          });
          factor[e.trade]! *= keep / held[e.trade]!;
          held[e.trade] = keep;
          if (keep === 0) {
            a.open = false;
            close(e.trade);
            continue;
          }
        }
      }
      a.fills.push({
        date: s.date,
        minute: s.minute,
        kind: "carry",
        qty: held[e.trade]!,
        price: s.price,
        reason: "carry",
      });
      continue;
    }
    const lastSale = !t.steps.slice(e.step + 1).some((x) => x.kind === "sell");
    let q = lastSale
      ? held[e.trade]!
      : Math.round(s.share * a.qty * factor[e.trade]!);
    q = Math.min(held[e.trade]!, Math.max(0, q));
    if (q === 0) continue;
    held[e.trade]! -= q;
    a.proceeds += q * s.price * 100;
    // A trade valued at the data's end pays no sale fee: it was not sold.
    if (s.reason !== "data-end") a.fees += fee(q);
    a.fills.push({
      date: s.date,
      minute: s.minute,
      kind: "sell",
      qty: q,
      price: s.price,
      reason: s.reason,
    });
    if (held[e.trade] === 0) close(e.trade);
  }
  if (day) curve.push({ date: day, equity });
  const taken = out.filter((a) => a.status === "taken");
  const wins = taken.filter((a) => a.pnl > 0);
  const losses = taken.filter((a) => a.pnl <= 0);
  const gain = wins.reduce((sum, a) => sum + a.pnl, 0);
  const loss = losses.reduce((sum, a) => sum + a.pnl, 0);
  let high = money.startEquity;
  let deepest = 0;
  for (const p of curve) {
    high = Math.max(high, p.equity);
    deepest = Math.max(deepest, (high - p.equity) / high);
  }
  return {
    trades: out,
    start: money.startEquity,
    end: equity,
    pnl: equity - money.startEquity,
    returnPct: ((equity - money.startEquity) / money.startEquity) * 100,
    taken: taken.length,
    wins: wins.length,
    losses: losses.length,
    winRate: taken.length ? (wins.length / taken.length) * 100 : 0,
    avgWin: wins.length ? gain / wins.length : 0,
    avgLoss: losses.length ? loss / losses.length : 0,
    profitFactor: loss < 0 ? gain / -loss : null,
    maxDrawdownPct: deepest * 100,
    curve,
    open: taken.filter((a) => a.open).length,
  };
}
