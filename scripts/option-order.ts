// Option orders from a chat command (docs/tasks/backend-option-orders.md).
//
//   preview --underlying ORCL --right call --delta 0.1 --size 0.5
//   buy --contract ORCL261016C00250000 --size 0.5 --delta 0.1
//
// Paper trading unless ALPACA_TRADING_LIVE=true. `buy` sends an order; run it
// only after the user approved the previewed contract.
import { parseArgs } from "node:util";
import { newYork } from "../packages/market-data/src/calendar.js";
import { TelegramSender } from "../packages/notifications/src/telegram.js";
import {
  AlpacaTrading,
  liveUrl,
  paperUrl,
} from "../packages/trading/src/alpaca-trading.js";
import { buyWithLadder } from "../packages/trading/src/ladder.js";
import { formatEntry } from "../packages/trading/src/message.js";
import {
  ceilingPrice,
  comingFriday,
  expiryChoices,
  pickByDelta,
  sizeContracts,
  spreadCheck,
  type Right,
} from "../packages/trading/src/options.js";

const env = (...names: string[]) =>
  names.map((n) => process.env[n]).find((v) => v) ?? "";

const key = env("ALPACA_API_KEY", "APCA_API_KEY_ID");
const secret = env("ALPACA_API_SECRET", "APCA_API_SECRET_KEY");
if (!key || !secret) {
  console.error("Set ALPACA_API_KEY and ALPACA_API_SECRET.");
  process.exit(1);
}
const live = process.env.ALPACA_TRADING_LIVE === "true";
const feed =
  process.env.ALPACA_OPTIONS_FEED === "indicative" ? "indicative" : "opra";
const client = new AlpacaTrading(key, secret, live ? liveUrl : paperUrl, feed);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    underlying: { type: "string" },
    right: { type: "string", default: "call" },
    delta: { type: "string", default: "0.1" },
    size: { type: "string" },
    contract: { type: "string" },
    steps: { type: "string", default: "5" },
    interval: { type: "string", default: "3" },
  },
});

const sizePct = Number(values.size);
const targetDelta = Number(values.delta);
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);

async function preview() {
  const underlying = values.underlying?.toUpperCase();
  const right = values.right as Right;
  if (!underlying || (right !== "call" && right !== "put"))
    throw new Error("Need --underlying and --right call|put");
  const today = newYork(Date.now()).date;
  const equity = await client.equity();
  let quotes = await client.chain(
    underlying,
    right,
    today,
    comingFriday(today),
  );
  if (!quotes.length)
    quotes = await client.chain(underlying, right, today, addDays(today, 21));
  const choices = expiryChoices(
    quotes.map((q) => q.expiry),
    today,
  );
  if (!choices) throw new Error(`No ${right}s listed for ${underlying}`);
  const expiries = [...new Set([choices.nearest, choices.friday])].filter(
    (e): e is string => e !== null,
  );
  const rows = expiries.map((expiry) => {
    const q = pickByDelta(
      quotes.filter((x) => x.expiry === expiry),
      targetDelta,
    );
    if (!q) return { expiry, error: "no quote with a delta" };
    const check = spreadCheck(q);
    const ceiling = ceilingPrice(q);
    const size = sizeContracts(equity, sizePct, ceiling);
    return {
      expiry,
      label:
        expiry === choices.nearest && expiry === choices.friday
          ? "nearest = Friday"
          : expiry === choices.nearest
            ? "nearest"
            : "Friday",
      contract: q.symbol,
      strike: q.strike,
      delta: q.delta,
      bid: q.bid,
      ask: q.ask,
      mid: Number(check.mid.toFixed(3)),
      spreadPctOfMid: Number((check.ratio * 100).toFixed(1)),
      spreadOk: check.ok,
      ceiling,
      qty: size.qty,
      maxCost: Number(size.cost.toFixed(2)),
      budget: Number(size.budget.toFixed(2)),
    };
  });
  console.log(
    JSON.stringify({ live, feed, equity, sizePct, targetDelta, rows }, null, 2),
  );
}

async function buy() {
  const symbol = values.contract?.toUpperCase();
  if (!symbol) throw new Error("Need --contract");
  const equity = await client.equity();
  const quote = await client.quote(symbol);
  const ceiling = ceilingPrice(quote);
  const { qty, budget } = sizeContracts(equity, sizePct, ceiling);
  if (qty < 1)
    throw new Error(
      `Budget ${budget.toFixed(2)} buys no contract at ${ceiling}`,
    );
  const result = await buyWithLadder(client, symbol, qty, {
    steps: Number(values.steps),
    intervalMs: Number(values.interval) * 1000,
    maxPrice: budget / (qty * 100),
    log: (line) => console.error(line),
  });
  console.log(JSON.stringify({ live, qty, budget, result }, null, 2));
  if (
    result.status === "rejected-spread" ||
    result.status === "rejected-budget"
  )
    return;
  const token = process.env.TRADES_TELEGRAM_BOT_TOKEN;
  const chat = process.env.TRADES_TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    console.error("Telegram not configured; no group message sent.");
    return;
  }
  const sent = await new TelegramSender(token, chat).send(
    formatEntry(
      {
        symbol,
        sizePct,
        targetDelta,
        delta: quote.delta,
        paper: !live,
        at: new Date(),
      },
      result,
    ),
  );
  console.error(sent.ok ? "Telegram sent" : `Telegram failed: ${sent.error}`);
}

const command = positionals[0];
(command === "preview"
  ? preview()
  : command === "buy"
    ? buy()
    : Promise.reject(new Error("Command: preview | buy"))
).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
