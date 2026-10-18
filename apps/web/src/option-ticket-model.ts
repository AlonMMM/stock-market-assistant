// The option buy ticket's form (user 2026-10-18: "like IBKR", every order
// type, "try to buy and increase" and "auto stop" as choices). The trading
// service checks the same rules again (packages/trading/src/option-tickets.ts).

export type OrderType = "market" | "limit" | "stop" | "stop_limit";
export type TimeInForce = "day" | "gtc";

export const orderTypes: { type: OrderType; label: string; hint: string }[] = [
  { type: "limit", label: "Limit", hint: "Buys at your price or lower." },
  { type: "market", label: "Market", hint: "Buys now at the ask." },
  {
    type: "stop",
    label: "Stop",
    hint: "Waits until the ask rises to the stop, then buys at the market.",
  },
  {
    type: "stop_limit",
    label: "Stop limit",
    hint: "Waits until the ask rises to the stop, then buys at your limit or lower.",
  },
];

export interface TicketForm {
  unit: "qty" | "pct";
  size: string;
  type: OrderType;
  // Limit only: start at the mid and raise toward the ask (the usual buy).
  ladder: boolean;
  limit: string;
  stop: string;
  tif: TimeInForce;
  autoStop: boolean;
  stopPct: string;
  force: boolean;
}

export const blankTicket = (mid: number): TicketForm => ({
  unit: "qty",
  size: "1",
  type: "limit",
  ladder: true,
  limit: onOptionTick(mid).toFixed(2),
  stop: "",
  tif: "day",
  autoStop: true,
  stopPct: "40",
  force: false,
});

// Option prices move in ticks: a cent below $3, 5 cents from $3.
export const optionTick = (p: number) => (p < 3 ? 0.01 : 0.05);

/** The price on the nearest tick, never below a cent. */
export function onOptionTick(p: number): number {
  const t = optionTick(p);
  return Math.max(0.01, Math.round(Math.round(p / t) * t * 100) / 100);
}

/** One tick up or down from the price typed. */
export function stepOptionPrice(p: number, up: boolean): number {
  const t = optionTick(up ? p : p - 1e-9);
  return onOptionTick(p + (up ? t : -t));
}

const tickOk = (p: number) => p > 0 && onOptionTick(p) === p;

/** Whether the stepped buy is chosen (a day limit with "try to buy"). */
export const stepped = (f: TicketForm) => f.type === "limit" && f.ladder;

/** The request body, or what the form still needs. */
export function ticketBody(
  contract: string,
  f: TicketForm,
): { body: Record<string, unknown> } | { problem: string } {
  const n = Number(f.size);
  if (!(n > 0)) return { problem: "Enter a size." };
  if (f.unit === "qty" && !Number.isInteger(n))
    return { problem: "Whole contracts only." };
  const body: Record<string, unknown> = {
    contract,
    ...(f.unit === "qty" ? { qty: n } : { sizePct: n }),
  };
  if (f.autoStop) {
    const pct = Number(f.stopPct);
    if (!(pct > 0)) return { problem: "Enter the stop %." };
    body.stopPct = pct;
  } else body.autoStop = false;
  if (f.force) body.force = true;
  if (stepped(f)) return { body };
  body.orderType = f.type;
  body.timeInForce = f.tif;
  if (f.type === "limit" || f.type === "stop_limit") {
    const p = Number(f.limit);
    if (!tickOk(p))
      return {
        problem: "Limit price: whole cents below $3, 5 cents from $3.",
      };
    body.limitPrice = p;
  }
  if (f.type === "stop" || f.type === "stop_limit") {
    const p = Number(f.stop);
    if (!tickOk(p))
      return {
        problem: "Stop price: whole cents below $3, 5 cents from $3.",
      };
    body.stopPrice = p;
  }
  return { body };
}

/** What the order will do, in a line, before it is checked. */
export function ticketLine(f: TicketForm, ask: number): string {
  if (stepped(f))
    return "Starts at the mid and raises toward the ask until it fills; what has not filled after 2 minutes is withdrawn.";
  const lasts =
    f.tif === "gtc"
      ? "Good till canceled (at the latest, the contract's expiry)."
      : "A day order: it ends at the close.";
  const stop = f.autoStop
    ? " Every contract that fills gets its stop while the order works."
    : " No stop is placed on what fills.";
  const what =
    f.type === "market"
      ? `Buys now at the ask (${ask.toFixed(2)}).`
      : f.type === "limit"
        ? `One order at ${f.limit || "your price"}.`
        : f.type === "stop"
          ? `Buys at the market once the ask reaches ${f.stop || "the stop"}.`
          : `Once the ask reaches ${f.stop || "the stop"}, a limit at ${f.limit || "your price"}.`;
  return `${what} ${lasts}${stop}`;
}
