import { escape } from "../../notifications/src/telegram.js";
import type { LadderResult } from "./ladder.js";
import { parseOccSymbol } from "./options.js";

const israelTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const shortDate = (date: string) => {
  const [, m, d] = date.split("-");
  return `${Number(d)}/${Number(m)}`;
};

export interface EntryNote {
  symbol: string;
  sizePct: number;
  targetDelta: number;
  delta: number | null;
  paper: boolean;
  at: Date;
}

// Placeholder group message until the user supplies Indy's post format.
export function formatEntry(note: EntryNote, result: LadderResult): string {
  const c = parseOccSymbol(note.symbol);
  const contract = `${c.underlying} ${c.strike}${c.right === "call" ? "C" : "P"} ${shortDate(c.expiry)}`;
  const order = result.order;
  const filled = order?.filledQty ?? 0;
  const lines = [
    ...(note.paper ? ["🧪 PAPER"] : []),
    `🟢 <b>${escape(contract)}</b>`,
    filled > 0 && order?.filledAvgPrice
      ? `Bought ${filled}${order.qty > filled ? ` of ${order.qty}` : ""} @ ${order.filledAvgPrice.toFixed(2)}`
      : `Working ${order?.qty ?? 0} @ ${result.prices.at(-1)?.toFixed(2) ?? "—"}`,
    `Size ${note.sizePct}% · delta ${note.delta === null ? "—" : Math.abs(note.delta).toFixed(2)} (target ${note.targetDelta})`,
    `${israelTime.format(note.at)} Israel time`,
  ];
  return lines.join("\n");
}
