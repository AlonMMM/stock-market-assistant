// Option orders from a chat command (docs/tasks/backend-option-orders.md).
//
//   preview --underlying ORCL --right call --size 0.5 [--delta 0.1]
//   buy --contract ORCL261016C00250000 --size 0.5 [--stop 40] [--wait 120]
//   stop --contract ORCL261016C00250000 [--stop 40]
//   sell --underlying ORCL --qty all|half|3   (or --contract …)
//   check   (short positions, or sell orders for more than is held)
//
// Paper trading unless ALPACA_TRADING_LIVE=true. `buy` sends an order; run it
// only after the user approved the previewed contract.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { TelegramSender } from "../packages/notifications/src/telegram.js";
import {
  AlpacaTrading,
  liveUrl,
  paperUrl,
} from "../packages/trading/src/alpaca-trading.js";
import { TradeEngine, type PostStore } from "../packages/trading/src/engine.js";
import {
  NoNotifier,
  TelegramNotifier,
  type Sent,
} from "../packages/trading/src/notifier.js";
import { defaultStopPct, type Right } from "../packages/trading/src/options.js";

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
    qty: { type: "string" }, // sell: all, half or a number of contracts
  },
});

const sizePct = Number(values.size);
const stopPct = Number(values.stop);
const waitMs = Number(values.wait) * 1000;

// The channel post of each open trade, so its exits are sent as replies.
// Local only (data/local is ignored by Git).
const postsPath = "data/local/trade-posts.json";
function readPosts(): Record<string, string | number> {
  try {
    return JSON.parse(readFileSync(postsPath, "utf8"));
  } catch {
    return {};
  }
}
const posts: PostStore = {
  async get(symbol) {
    const ref = readPosts()[symbol];
    return ref === undefined ? undefined : String(ref);
  },
  async set(symbol, ref) {
    try {
      const all = readPosts();
      if (ref === null) delete all[symbol];
      else all[symbol] = ref;
      mkdirSync("data/local", { recursive: true });
      writeFileSync(postsPath, JSON.stringify(all, null, 2));
    } catch {
      // Without the file the next exit is posted on its own.
    }
  },
};

const token = process.env.TRADES_TELEGRAM_BOT_TOKEN;
const chat = process.env.TRADES_TELEGRAM_CHAT_ID;
const engine = new TradeEngine({
  broker: client,
  notifier:
    token && chat
      ? new TelegramNotifier(new TelegramSender(token, chat))
      : new NoNotifier(),
  posts,
  log: (line) => console.error(line),
});

// The engine reports `paper`; this command has always printed `live`.
const print = ({
  paper,
  ...rest
}: { paper: boolean } & Record<string, unknown>) =>
  console.log(JSON.stringify({ live: !paper, ...rest }, null, 2));
const posted = (post: Sent | undefined, nothing: string) =>
  console.error(
    post === undefined
      ? `${nothing}; no group message sent.`
      : post.ok
        ? "Notification sent"
        : `No group message sent: ${post.error}`,
  );

async function preview() {
  const right = values.right as Right;
  if (!values.underlying || (right !== "call" && right !== "put"))
    throw new Error("Need --underlying and --right call|put");
  const { paper, ...rest } = await engine.preview({
    underlying: values.underlying,
    right,
    sizePct,
    ...(values.delta === undefined ? {} : { delta: Number(values.delta) }),
    stopPct,
  });
  print({ paper, feed, ...rest });
}

async function buy() {
  if (!values.contract) throw new Error("Need --contract");
  const outcome = await engine.buy({
    contract: values.contract,
    sizePct,
    stopPct,
    steps: Number(values.steps),
    intervalMs: Number(values.interval) * 1000,
    waitMs,
  });
  const { post, ...rest } = { post: undefined, ...outcome };
  print(rest);
  if ("stop" in outcome) posted(post, "Nothing filled");
}

// Sells at the bid, trying again at the new bid every 5 seconds.
async function sell() {
  if (!values.contract && !values.underlying)
    throw new Error("Need --contract or --underlying");
  if (!values.qty) throw new Error("Need --qty all|half|<contracts>");
  const outcome = await engine.sell({
    ...(values.contract ? { contract: values.contract } : {}),
    ...(values.underlying ? { underlying: values.underlying } : {}),
    qty: values.qty,
    stopPct,
    waitMs,
  });
  const { post, ...rest } = { post: undefined, ...outcome };
  print(rest);
  posted(post, "Nothing sold");
}

// Places the stop for a contract already held, at its average entry price.
async function stop() {
  if (!values.contract) throw new Error("Need --contract");
  print(await engine.setStop({ contract: values.contract, stopPct }));
}

// The account must never be short an option. Run after every order command
// and by `check`: any short position, or sell orders for more than is held,
// is printed, sent to the trades channel and fails the command.
async function shortCheck() {
  const { problems, alert } = await engine.shortCheck();
  if (problems.length === 0) return problems;
  console.error(`\nALERT: SHORT OPTION RISK\n${problems.join("\n")}\n`);
  console.error(
    alert?.ok ? "Alert sent" : `Alert not sent: ${alert?.error ?? "unknown"}`,
  );
  process.exitCode = 2;
  return problems;
}

const command = positionals[0];
const commands: Record<string, () => Promise<unknown>> = {
  preview,
  buy,
  stop,
  sell,
  check: async () => {
    const problems = await shortCheck();
    if (problems.length === 0)
      console.log("No short positions and no oversized sell orders.");
  },
};
const run = commands[command ?? ""];
(run
  ? run()
  : Promise.reject(new Error(`Command: ${Object.keys(commands).join(" | ")}`))
)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  // Whatever an order command did or failed to do, look at the account.
  .then(() =>
    command === "buy" || command === "sell" || command === "stop"
      ? shortCheck().catch((error: unknown) => {
          console.error(
            `ALERT: the short-position check itself failed: ${error instanceof Error ? error.message : error}`,
          );
          process.exitCode = 2;
        })
      : undefined,
  );
