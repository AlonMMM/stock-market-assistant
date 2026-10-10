// Option orders from a chat command (docs/tasks/backend-option-orders.md).
//
//   preview --underlying ORCL --right call --size 0.5 [--delta 0.1]
//   buy --contract ORCL261016C00250000 --size 0.5 [--stop 40] [--wait 120]
//   stop --contract ORCL261016C00250000 [--stop 40]
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
import { protectFill } from "../packages/trading/src/protect.js";
import { formatEntry, type StopNote } from "../packages/trading/src/message.js";
import {
  ceilingPrice,
  comingFriday,
  defaultDeltaRange,
  defaultStopPct,
  expiryChoices,
  pickByDelta,
  sizeContracts,
  spreadCheck,
  stopPrice,
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
    delta: { type: "string" },
    size: { type: "string" },
    contract: { type: "string" },
    steps: { type: "string", default: "5" },
    interval: { type: "string", default: "3" },
    stop: { type: "string", default: String(defaultStopPct) },
    // Seconds an unfilled order is watched after the raises, then canceled.
    wait: { type: "string", default: "120" },
  },
});

const sizePct = Number(values.size);
// An explicit --delta is the target; otherwise the middle of the default range.
const [deltaLow, deltaHigh] = defaultDeltaRange;
const targetDelta =
  values.delta === undefined
    ? (deltaLow + deltaHigh) / 2
    : Number(values.delta);
const deltaLabel =
  values.delta === undefined
    ? `${deltaLow.toFixed(2)}–${deltaHigh.toFixed(2)}`
    : String(targetDelta);
const stopPct = Number(values.stop);
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
      ...(values.delta === undefined && q.delta !== null
        ? {
            deltaInRange:
              Math.abs(q.delta) >= deltaLow - 1e-9 &&
              Math.abs(q.delta) <= deltaHigh + 1e-9,
          }
        : {}),
      bid: q.bid,
      ask: q.ask,
      mid: Number(check.mid.toFixed(3)),
      spreadPctOfMid: Number((check.ratio * 100).toFixed(1)),
      spreadOk: check.ok,
      ceiling,
      stopAtCeiling: stopPrice(ceiling, stopPct),
      qty: size.qty,
      maxCost: Number(size.cost.toFixed(2)),
      budget: Number(size.budget.toFixed(2)),
    };
  });
  console.log(
    JSON.stringify(
      {
        live,
        feed,
        equity,
        sizePct,
        targetDelta: deltaLabel,
        stopPct,
        rows,
      },
      null,
      2,
    ),
  );
}

async function buy() {
  const symbol = values.contract?.toUpperCase();
  if (!symbol) throw new Error("Need --contract");
  stopPrice(1, stopPct); // refuse a bad --stop before anything is sent
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
  if (
    result.status === "rejected-spread" ||
    result.status === "rejected-budget"
  ) {
    console.log(JSON.stringify({ live, qty, budget, result }, null, 2));
    return;
  }
  // Watch the order, keep a stop on what fills, cancel what does not.
  const guarded = await protectFill(client, result.order!, stopPct, {
    waitMs: Number(values.wait) * 1000,
    log: (line) => console.error(line),
  });
  const order = guarded.order;
  const final = {
    ...result,
    order,
    status:
      order.status === "filled"
        ? ("filled" as const)
        : guarded.cancelError
          ? result.status
          : ("closed" as const),
  };
  const { stop, canceledQty, cancelError } = guarded;
  console.log(
    JSON.stringify(
      { live, qty, budget, result: final, stop, canceledQty, cancelError },
      null,
      2,
    ),
  );
  if (!(order.filledQty > 0)) {
    console.error("Nothing filled; no group message sent.");
    return;
  }
  const token = process.env.TRADES_TELEGRAM_BOT_TOKEN;
  const chat = process.env.TRADES_TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    console.error("Telegram not configured; no group message sent.");
    return;
  }
  const sent = await new TelegramSender(token, chat).send(
    formatEntry({ symbol, paper: !live, stop }, final),
  );
  console.error(sent.ok ? "Telegram sent" : `Telegram failed: ${sent.error}`);
}

// Places the stop for a contract already held, at its average entry price.
async function stop() {
  const symbol = values.contract?.toUpperCase();
  if (!symbol) throw new Error("Need --contract");
  const held = await client.position(symbol);
  if (!(held.qty > 0)) throw new Error(`No long position in ${symbol}`);
  const price = stopPrice(held.avgEntryPrice, stopPct);
  const order = await client.sellStop(symbol, held.qty, price);
  console.log(
    JSON.stringify(
      { live, entry: held.avgEntryPrice, stopPct, price, order },
      null,
      2,
    ),
  );
}

const command = positionals[0];
(command === "preview"
  ? preview()
  : command === "buy"
    ? buy()
    : command === "stop"
      ? stop()
      : Promise.reject(new Error("Command: preview | buy | stop"))
).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
