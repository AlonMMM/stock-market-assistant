// The broker-style stock ticket on Trade → Shares (user 2026-10-17: "all the
// options a real broker gives"). These are the trading service's rules
// (packages/trading/src/stock-tickets.ts), kept here so the form offers only
// what can be sent; the service checks every order again.

export type OrderType =
  "market" | "limit" | "stop" | "stop_limit" | "trailing_stop";
export type TimeInForce = "day" | "gtc" | "opg" | "cls" | "ioc" | "fok";
// "auto" is the stepped limit from the mid (`/stock/buy|sell`).
export type TicketType = OrderType | "auto";

export const ticketTypes: { type: TicketType; label: string }[] = [
  { type: "market", label: "Market" },
  { type: "limit", label: "Limit" },
  { type: "stop", label: "Stop" },
  { type: "stop_limit", label: "Stop limit" },
  { type: "trailing_stop", label: "Trailing stop" },
  { type: "auto", label: "Auto (stepped)" },
];

export const tifLabels: Record<TimeInForce, string> = {
  day: "Day",
  gtc: "Good till canceled",
  opg: "At the open",
  cls: "At the close",
  ioc: "Immediate or cancel",
  fok: "Fill or kill",
};

export const allowedTimeInForce: Record<OrderType, TimeInForce[]> = {
  market: ["day", "gtc", "opg", "cls", "ioc", "fok"],
  limit: ["day", "gtc", "opg", "cls", "ioc", "fok"],
  stop: ["day", "gtc"],
  stop_limit: ["day", "gtc"],
  trailing_stop: ["day", "gtc"],
};

export const typeExplained: Record<TicketType, string> = {
  market: "Fills now at the best price available.",
  limit: "Fills only at your limit price or better.",
  stop: "Becomes a market order once the price reaches the stop.",
  stop_limit:
    "Becomes a limit order at your limit price once the price reaches the stop.",
  trailing_stop:
    "A stop that follows the price by a percent or dollar amount and fires when it turns back by that much.",
  auto: "A limit order from the mid, stepped toward the ask (buy) or bid (sell). What does not fill stays working for the day.",
};

export const extendedAllowed = (type: TicketType, tif: TimeInForce) =>
  type === "limit" && (tif === "day" || tif === "gtc");

export interface TicketForm {
  side: "buy" | "sell";
  type: TicketType;
  tif: TimeInForce;
  // A buy is sized in shares or dollars; a sell in shares, "all" or "half".
  unit: "qty" | "usd";
  size: string;
  limit: string;
  stop: string;
  trailBy: "percent" | "price";
  trail: string;
  extended: boolean;
}

export const blankForm: TicketForm = {
  side: "buy",
  type: "limit",
  tif: "day",
  unit: "qty",
  size: "1",
  limit: "",
  stop: "",
  trailBy: "percent",
  trail: "5",
  extended: false,
};

const positive = (s: string) => {
  const n = Number(s);
  return s.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
};

/** The body to send, or the reason the form is not ready yet. */
export function ticketBody(
  symbol: string,
  f: TicketForm,
): { body: Record<string, unknown> } | { problem: string } {
  const sell = f.side === "sell";
  let sized: Record<string, unknown>;
  if (sell && (f.size === "all" || f.size === "half")) sized = { qty: f.size };
  else {
    const n = positive(f.size);
    if (n === null) return { problem: "Enter a size." };
    if (sell || f.unit === "qty") {
      if (!Number.isInteger(n)) return { problem: "Whole shares only." };
      sized = { qty: n };
    } else sized = { amount: n };
  }
  if (f.type === "auto") return { body: { symbol, ...sized } };

  const body: Record<string, unknown> = {
    symbol,
    side: f.side,
    type: f.type,
    timeInForce: f.tif,
    ...sized,
  };
  if (f.type === "limit" || f.type === "stop_limit") {
    const p = positive(f.limit);
    if (p === null) return { problem: "Enter a limit price." };
    body.limitPrice = p;
  }
  if (f.type === "stop" || f.type === "stop_limit") {
    const p = positive(f.stop);
    if (p === null) return { problem: "Enter a stop price." };
    body.stopPrice = p;
  }
  if (f.type === "trailing_stop") {
    const t = positive(f.trail);
    if (t === null) return { problem: "Enter the trail." };
    if (f.trailBy === "percent") {
      if (t >= 100) return { problem: "The trail must be under 100%." };
      body.trailPercent = t;
    } else body.trailPrice = t;
  }
  if (f.extended && extendedAllowed(f.type, f.tif)) body.extendedHours = true;
  return { body };
}

/** A form after a change of type: a time in force the type takes. */
export function withType(f: TicketForm, type: TicketType): TicketForm {
  const tif =
    type === "auto" || allowedTimeInForce[type].includes(f.tif) ? f.tif : "day";
  return {
    ...f,
    type,
    tif,
    extended: f.extended && extendedAllowed(type, tif),
  };
}

export interface OpenStockOrder {
  orderId: string;
  side: string;
  type?: string;
  timeInForce?: string;
  qty: number;
  filledQty: number;
  price: number | null;
  limitPrice?: number | null;
  stopPrice?: number | null;
  trailPercent?: number | null;
  trailPrice?: number | null;
  extendedHours?: boolean;
}

export const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n >= 1 ? n.toFixed(2) : n.toFixed(4);

const typeLabel = (type: string | undefined) =>
  ticketTypes.find((t) => t.type === type)?.label ?? type ?? "Limit";

/** "Sell 10 · Stop limit · stop 95.00 limit 94.50 · GTC". */
export function describeOrder(o: OpenStockOrder): string {
  const prices: string[] = [];
  if (o.stopPrice != null) prices.push(`stop ${money(o.stopPrice)}`);
  if (o.limitPrice != null) prices.push(`limit ${money(o.limitPrice)}`);
  else if (o.price != null && o.stopPrice == null)
    prices.push(`limit ${money(o.price)}`);
  if (o.trailPercent != null) prices.push(`trail ${o.trailPercent}%`);
  if (o.trailPrice != null) prices.push(`trail $${money(o.trailPrice)}`);
  const left = o.qty - o.filledQty;
  return [
    `${o.side === "sell" ? "Sell" : "Buy"} ${left}${o.filledQty ? ` (${o.filledQty} filled)` : ""}`,
    typeLabel(o.type),
    ...prices,
    (o.timeInForce ?? "day").toUpperCase() + (o.extendedHours ? " + ext" : ""),
  ].join(" · ");
}

/** Which prices an open order has that a change may move. */
export function changeable(o: OpenStockOrder) {
  const type = o.type ?? (o.stopPrice == null ? "limit" : "stop");
  return {
    limit: type === "limit" || type === "stop_limit",
    stop: type === "stop" || type === "stop_limit",
    trail: type === "trailing_stop",
  };
}

/** The change to send for an open order, or why not; null when unchanged. */
export function changeBody(
  o: OpenStockOrder,
  edit: { qty: string; limit: string; stop: string; trail: string },
): { body: Record<string, unknown> } | { problem: string } | null {
  const body: Record<string, unknown> = { orderId: o.orderId };
  const qty = positive(edit.qty);
  if (qty === null || !Number.isInteger(qty))
    return { problem: "Whole shares only." };
  if (qty !== o.qty) body.qty = qty;
  const has = changeable(o);
  const pairs: [string, boolean, string, number | null | undefined][] = [
    ["limitPrice", has.limit, edit.limit, o.limitPrice ?? o.price],
    ["stopPrice", has.stop, edit.stop, o.stopPrice],
    ["trail", has.trail, edit.trail, o.trailPercent ?? o.trailPrice],
  ];
  for (const [name, shown, text, was] of pairs) {
    if (!shown) continue;
    const n = positive(text);
    if (n === null) return { problem: "Enter a price above zero." };
    if (n !== was) body[name] = n;
  }
  return Object.keys(body).length > 1 ? { body } : null;
}
