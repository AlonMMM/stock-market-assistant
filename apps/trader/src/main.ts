// The trading service (docs/tasks/backend-trading-service.md): holds the
// broker keys, runs orders as jobs and keeps the trade records. Only the
// hosted site talks to it, with TRADER_TOKEN; Claude reaches it through the
// site's connector and never sees a key.
import { TelegramSender } from "../../../packages/notifications/src/telegram.js";
import { TelegramNotifier } from "../../../packages/trading/src/notifier.js";
import {
  accountRiskBounds,
  defaultAccountRisk,
  parseAccountRisk,
  withDefaults,
} from "../../../packages/trading/src/account-risk.js";
import { timingSafeEqual } from "node:crypto";
import { newYork } from "../../../packages/market-data/src/calendar.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import { Vault } from "./secrets.js";
import { StoqeyTws } from "../../../packages/trading/src/tws-client.js";
import { ensureOwnerIbkr, seedOwner } from "./seed.js";
import {
  botAccountFor,
  botAccountSuffix,
  botBrokerFromEnv,
  ensureBotAccount,
  ensureStrangleAccount,
  strangleAccount,
  strangleAccountSuffix,
  strangleKeyVariable,
} from "./seed-bot.js";
import { StrangleBot, strangleTag } from "./strangle.js";
import { StrangleStore } from "./strangle-store.js";
import { parseStrangleSettings } from "../../../packages/trading/src/strangle/settings.js";
import { EquityLog } from "./equity-log.js";
import { botHistory, botPortfolio } from "./bot-portfolio.js";
import { ShortWatch } from "./short-watch.js";
import { RequestError, type TraderService } from "./service.js";
import { TradeStore } from "./store.js";
import { Traders } from "./traders.js";
import botUniverse from "../../../config/bot-universe.json" with { type: "json" };
import { IndiBot } from "./bot.js";
import { nasdaqEarnings } from "./bot-news.js";
import { AlpacaBotMarket } from "./bot-market.js";
import { BotStore } from "./bot-store.js";
import {
  botBrokers,
  parseSettings,
  type BotBroker,
} from "../../../packages/trading/src/bot/settings.js";

const env = (...names: string[]) =>
  names.map((n) => process.env[n]).find((v) => v) ?? "";

const token = env("TRADER_TOKEN");
if (token.length < 32)
  throw new Error("Set a random TRADER_TOKEN of at least 32 characters");
// The live account needs the user's separate authorization and its own switch.
if (process.env.ALPACA_TRADING_LIVE === "true")
  throw new Error("This service trades the paper account only");

const dbPath = process.env.TRADER_DB ?? "data/local/trader.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const store = new TradeStore(dbPath);
const log = (line: string) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), line }));

// The traders, their accounts and channels (docs/features/multi-user-ibkr.md).
// On the first start the single trader of before becomes the owner.
const seeded = seedOwner(store, process.env, Date.now());
if (seeded) log(`added the owner "${seeded}" from the environment`);
const ibkr = ensureOwnerIbkr(store, process.env, Date.now());
if (ibkr) log(`added the owner's IBKR paper account "${ibkr}"`);
const botAdded = ensureBotAccount(store, process.env, Date.now());
if (botAdded) log(`added the bot's own Alpaca paper account "${botAdded}"`);
const strangleAdded = ensureStrangleAccount(store, process.env, Date.now());
if (strangleAdded)
  log(`added the strangle bot's own Alpaca paper account "${strangleAdded}"`);
const vaultKey = env("TRADER_VAULT_KEY");
// The Alert leg bot's own Telegram chat (bot-channel.ts): both values, or neither.
const legToken = process.env.ALERT_LEG_TELEGRAM_BOT_TOKEN ?? "";
const legChat = process.env.ALERT_LEG_TELEGRAM_CHAT_ID ?? "";
if (!legToken !== !legChat)
  throw new Error(
    "Set both ALERT_LEG_TELEGRAM_BOT_TOKEN and ALERT_LEG_TELEGRAM_CHAT_ID, or neither",
  );
const legNotifier = legToken
  ? new TelegramNotifier(new TelegramSender(legToken, legChat))
  : null;
const traders = new Traders({
  store,
  bots: legNotifier ? { notifier: legNotifier, tags: [strangleTag] } : null,
  secrets: {
    env: process.env,
    ...(vaultKey ? { vault: new Vault(vaultKey) } : {}),
  },
  enabled: process.env.TRADING_ENABLED !== "false",
  optionsFeed:
    process.env.ALPACA_OPTIONS_FEED === "indicative" ? "indicative" : "opra",
  // One client id per Gateway connection; the collector will use another.
  makeTws: (host, port) =>
    new StoqeyTws({
      host,
      port,
      clientId: Number(process.env.IBKR_CLIENT_ID ?? 11),
      log,
    }),
  log,
});
// Fails the start when the owner cannot be built, as a missing key did.
traders.forCaller(undefined);

const api = Fastify({ bodyLimit: 16384 });
// A second, optional token that can only read: the website shows orders and
// their reasons with it and can never send one.
const readToken = env("TRADER_READ_TOKEN");
if (readToken && readToken.length < 32)
  throw new Error("TRADER_READ_TOKEN must be at least 32 characters");
const bearer = (header: string | undefined, value: string) => {
  const expected = Buffer.from(`Bearer ${value}`);
  const actual = Buffer.from(header ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
api.addHook("onRequest", async (request, reply) => {
  if (request.url === "/health") return;
  const header = request.headers.authorization;
  const reading =
    readToken !== "" && request.method === "GET" && bearer(header, readToken);
  if (!reading && !bearer(header, token))
    return reply.code(401).send({ error: "Unauthorized" });
});
api.setErrorHandler((error, _request, reply) => {
  if (error instanceof RequestError)
    return reply.code(error.status).send({ error: error.message });
  const text = error instanceof Error ? error.message : String(error);
  log(`request failed: ${text}`);
  return reply.code(502).send({ error: text });
});
// The site forwards whom a call is for; without it, the owner's. A call may
// name the broker (`X-Trader-Broker`, or `broker` in the body or query);
// without it, the trader's default account.
const service = (request: FastifyRequest): TraderService => {
  const caller = request.headers["x-trader-user"];
  const named =
    request.headers["x-trader-broker"] ??
    body(request.body).broker ??
    body(request.query).broker;
  if (named !== undefined && named !== "alpaca" && named !== "ibkr")
    throw new RequestError("broker must be alpaca or ibkr");
  return traders.forCaller(
    typeof caller === "string" && caller !== "" ? caller : undefined,
    named as "alpaca" | "ibkr" | undefined,
  ).service;
};
const body = (value: unknown) =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

// No account data here: it only says the process is up.
api.get("/health", async () => ({ ok: true }));
api.post("/v1/preview", async (request) =>
  service(request).preview(body(request.body)),
);
api.post("/v1/check", async (request) =>
  service(request).check(body(request.body)),
);
api.get("/v1/chain", async (request) =>
  service(request).chain(body(request.query)),
);
api.post("/v1/buy", async (request) =>
  service(request).buy(body(request.body)),
);
api.post("/v1/spread/check", async (request) =>
  service(request).spreadCheck(body(request.body)),
);
api.post("/v1/spread/buy", async (request) =>
  service(request).spreadBuy(body(request.body)),
);
api.post("/v1/spread/close", async (request) =>
  service(request).spreadClose(body(request.body)),
);
api.post("/v1/sell", async (request) =>
  service(request).sell(body(request.body)),
);
api.post("/v1/stop", async (request) =>
  service(request).stop(body(request.body)),
);
api.post("/v1/stop/move", async (request) =>
  service(request).moveStop(body(request.body)),
);
api.post("/v1/orders/cancel", async (request) =>
  service(request).cancelOrder(body(request.body)),
);
api.post("/v1/orders/price", async (request) =>
  service(request).repriceOrder(body(request.body)),
);
api.post("/v1/resize", async (request) =>
  service(request).resize(body(request.body)),
);
api.get("/v1/stock/quote", async (request) =>
  service(request).stockQuote(body(request.query)),
);
api.post("/v1/stock/buy", async (request) =>
  service(request).stockBuy(body(request.body)),
);
api.post("/v1/stock/sell", async (request) =>
  service(request).stockSell(body(request.body)),
);
api.post("/v1/stock/order", async (request) =>
  service(request).stockOrder(body(request.body)),
);
api.post("/v1/orders/change", async (request) =>
  service(request).changeOrder(body(request.body)),
);
api.get<{ Params: { id: string } }>("/v1/jobs/:id", async (request) =>
  service(request).job(request.params.id),
);
api.post<{ Params: { id: string } }>("/v1/jobs/:id/cancel", async (request) =>
  service(request).cancel({ jobId: request.params.id }),
);
api.post("/v1/cancel", async (request) =>
  service(request).cancel(body(request.body)),
);
// The owner's risk settings, per account (account-risk.ts; user 2026-10-26).
const riskLabel = (a: { id: string; broker: string; userId: string }) => {
  const labels: Record<string, string> = {
    [`${a.userId}-alpaca`]: "Your Alpaca account",
    [`${a.userId}-${botAccountSuffix}`]: "Main bot · Alpaca",
    [`${a.userId}-ibkr`]: "Interactive Brokers · you and the main bot",
    [`${a.userId}-${strangleAccountSuffix}`]: "Volume bot · Alpaca",
  };
  return labels[a.id] ?? `${a.broker} · ${a.id}`;
};
const riskAccounts = () =>
  store
    .users()
    .flatMap((u) => store.accounts(u.id))
    .filter((a) => a.enabled);
api.get("/v1/risk", async () => {
  const accounts = await Promise.all(
    riskAccounts().map(async (a) => {
      // The account's state now, if it answers in time (IBKR may not).
      const status = await Promise.race([
        traders
          .forAccount(a.id)
          .engine.status()
          .catch(() => null),
        new Promise<null>((done) => setTimeout(() => done(null), 8000)),
      ]);
      return {
        id: a.id,
        broker: a.broker,
        label: riskLabel(a),
        settings: withDefaults(store.accountRisk(a.id)),
        saved: store.accountRisk(a.id) !== null,
        now: status
          ? {
              equity: status.equity,
              dayChangePct: status.dayChangePct,
              state: status.limits.riskManager.state,
              reason: status.limits.riskManager.reason,
            }
          : null,
      };
    }),
  );
  return { accounts, defaults: defaultAccountRisk, bounds: accountRiskBounds };
});
api.put("/v1/risk", async (request) => {
  const b = body(request.body);
  const account = riskAccounts().find((a) => a.id === b.accountId);
  if (!account) throw new RequestError("No such account");
  const risk = parseAccountRisk(b.settings);
  if (typeof risk === "string") throw new RequestError(risk);
  store.setAccountRisk(account.id, risk, Date.now());
  traders.reloadRisk(account.id);
  log(`risk settings of ${account.id}: ${JSON.stringify(risk)}`);
  return { id: account.id, settings: risk };
});
api.get("/v1/positions", async (request) => service(request).status());
api.get<{ Querystring: { limit?: string } }>("/v1/decisions", async (request) =>
  service(request).decisions(Number(request.query.limit)),
);

// The Indi bot (docs/tasks/backend-indi-bot.md). It can trade at two brokers
// (docs/tasks/backend-bot-ibkr.md): the owner's IBKR paper account behind the
// Gateway, and its own Alpaca paper account once BOT_ALPACA_API_KEY /
// BOT_ALPACA_API_SECRET are set (docs/tasks/backend-bot-account.md), else the
// owner's default account. New entries go to the broker chosen on the Bot
// settings page, BOT_BROKER until the owner saves; a position is sold where it
// was bought. Always through the owner's trading service. Off unless
// BOT_ENABLED=true; a dry run unless BOT_MODE=live. Market data comes from the
// owner's Alpaca keys either way.
const botStore = new BotStore(dbPath);
let botOff = "The bot has no Alpaca keys";
/** The trader (account, service, channels) the bot uses at one broker. */
const botTraderFor = (broker: BotBroker) => {
  const account = botAccountFor(store, broker);
  if (!account) throw new RequestError(`The bot has no ${broker} account`, 409);
  return traders.forAccount(account.id);
};
const botBrokerOf = (value: unknown): BotBroker => {
  if (value !== "alpaca" && value !== "ibkr")
    throw new RequestError("broker must be alpaca or ibkr");
  return value;
};
const bot = (() => {
  const key = env("ALPACA_API_KEY", "APCA_API_KEY_ID");
  const secret = env("ALPACA_API_SECRET", "APCA_API_SECRET_KEY");
  if (!key || !secret) return null;
  // A wrong BOT_BROKER stops the service: the bot must never trade the wrong
  // account by accident.
  const startBroker = botBrokerFromEnv(process.env);
  const traderFor = botTraderFor;
  // Only a broker whose account builds (keys, Gateway) can be chosen.
  const connected = botBrokers.filter((broker) => {
    try {
      traderFor(broker);
      return true;
    } catch (error) {
      log(
        `the bot cannot trade at ${broker}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  });
  const startable =
    startBroker === "both"
      ? botBrokers.every((b) => connected.includes(b))
      : connected.includes(startBroker);
  if (!startable) {
    botOff = `The bot's ${startBroker} account(s) cannot start`;
    log(`${botOff}; the bot is off`);
    return null;
  }
  log(
    `the bot can trade at ${connected.map((b) => `${b} ("${traderFor(b).account.id}")`).join(" and ")}; new entries at ${startBroker} until the owner chooses on the Bot settings page`,
  );
  // The owner's channels are the same for every account.
  const owner = () => traders.forCaller(undefined);
  return new IndiBot({
    broker: startBroker,
    brokers: connected,
    trading: (broker) => {
      const t = traderFor(broker);
      return {
        chain: (u, right, from, to) => t.broker.chain(u, right, from, to),
        quote: (c) => t.broker.quote(c),
        held: async (c) => {
          const p = await t.broker.position(c).catch(() => null);
          return p && p.qty > 0 ? p : null;
        },
        equity: () => t.broker.equity(),
        buy: (b) => t.service.buy(b),
        sell: (b) => t.service.sell(b),
        job: (id) => t.service.job(id),
      };
    },
    store: botStore,
    market: new AlpacaBotMarket(key, secret, "sip"),
    notify: (title, lines) => owner().notifier.notice(title, lines),
    universe: botUniverse.symbols,
    earnings: (date) => nasdaqEarnings(date),
    mode: process.env.BOT_MODE === "live" ? "live" : "dry",
    enabled: process.env.BOT_ENABLED === "true",
    log,
  });
})();
// Every 10 s: the exit checks run each tick, the entries once per closed
// minute (user 2026-10-23).
// Every 5 seconds: early entry (version 2.7) checks the forming minute on each
// tick, and every 10 seconds keeps only about half of its gain (sec_timing.py).
const botTimer = bot ? setInterval(() => void bot.tick(), 5_000) : null;
api.get("/v1/bot", async () => {
  if (!bot) throw new RequestError(botOff, 409);
  return bot.status();
});
// The site sends the user's favorites list before each session.
// The strangle bot follows the same favorites list (docs/tasks/backend-strangle-bot.md).
api.post("/v1/bot/watchlist", async (request) => {
  if (!bot && !strangle) throw new RequestError(botOff, 409);
  const b = body(request.body);
  if (typeof b.name !== "string" || !Array.isArray(b.tickers))
    throw new RequestError("Need name and tickers");
  const name = b.name.slice(0, 40);
  const tickers = b.tickers.map(String).slice(0, 200);
  strangle?.setWatchlist(name, tickers);
  return { tickers: bot ? bot.setWatchlist(name, tickers) : tickers };
});
api.post("/v1/bot", async (request) => {
  if (!bot) throw new RequestError(botOff, 409);
  const on = body(request.body).enabled;
  if (typeof on !== "boolean")
    throw new RequestError("enabled must be true or false");
  bot.setEnabled(on);
  return bot.status();
});

// The owner's settings from the site's Bot settings page (docs/tasks/backend-bot-settings.md).
api.get("/v1/bot/settings", async () => {
  if (!bot) throw new RequestError(botOff, 409);
  return bot.settings();
});
api.put("/v1/bot/settings", async (request) => {
  if (!bot) throw new RequestError(botOff, 409);
  const parsed = parseSettings(request.body);
  if (!parsed.ok) throw new RequestError(parsed.error);
  if (!bot.canTrade(parsed.value.broker))
    throw new RequestError(
      `The bot has no ${parsed.value.broker} account connected`,
      409,
    );
  return bot.setSettings(parsed.value);
});
// The Bot trades tab for an account the site cannot read itself (IBKR): the
// bot's positions there with live marks, and its closed trades
// (docs/tasks/backend-bot-ibkr.md). Readable with the read-only token.
api.get("/v1/bot/portfolio", async (request) => {
  if (!bot) throw new RequestError(botOff, 409);
  const broker = botBrokerOf(body(request.query).broker);
  const t = botTraderFor(broker);
  return botPortfolio(t.broker, bot.positionsAt(broker), Date.now());
});
api.get("/v1/bot/portfolio/history", async (request) => {
  if (!bot) throw new RequestError(botOff, 409);
  const q = body(request.query);
  const broker = botBrokerOf(q.broker);
  const t = botTraderFor(broker);
  // The service's own daily record (equity-log.ts), else the broker's.
  const recorded = store.equityDays(t.account.id);
  const days = recorded.length ? recorded : await t.broker.equityHistory();
  const since = newYork(Date.now() - 366 * 86_400_000).date;
  const history = botHistory(
    days,
    bot.positionsAt(broker, since),
    q.period,
    t.broker.capabilities.paper,
    Date.now(),
  );
  // The history's own status, not a 200 wrapping it (the page reads the body).
  if (history.status !== 200)
    throw new RequestError(
      (history.body as { error: string }).error,
      history.status,
    );
  return history.body;
});

// The alert strangle (docs/tasks/backend-strangle-bot.md): a second bot on
// its own Alpaca paper account only (STRANGLE_ALPACA_API_KEY / _SECRET); it
// never trades another account. Its on/off and dry run are its own settings,
// saved from the site's Strangle settings page; market data comes from the
// owner's Alpaca keys, as the Indi bot's.
const strangleStore = new StrangleStore(dbPath);
let strangleOff = `The strangle bot has no account: set ${strangleKeyVariable} and its secret`;
const strangle = (() => {
  const key = env("ALPACA_API_KEY", "APCA_API_KEY_ID");
  const secret = env("ALPACA_API_SECRET", "APCA_API_SECRET_KEY");
  const account = strangleAccount(store);
  if (!key || !secret || !account || !account.enabled) return null;
  let t: ReturnType<typeof traders.forAccount>;
  try {
    t = traders.forAccount(account.id);
  } catch (error) {
    strangleOff = `The strangle bot's account cannot start: ${error instanceof Error ? error.message : String(error)}`;
    log(strangleOff);
    return null;
  }
  log(`the strangle bot trades its own account "${account.id}"`);
  const owner = () => traders.forCaller(undefined);
  return new StrangleBot({
    store: strangleStore,
    market: new AlpacaBotMarket(key, secret, "sip"),
    account: account.id,
    trading: {
      chain: (u, right, from, to) => t.broker.chain(u, right, from, to),
      quote: (c) => t.broker.quote(c),
      held: async (c) => {
        const p = await t.broker.position(c).catch(() => null);
        return p && p.qty > 0 ? p : null;
      },
      equity: () => t.broker.equity(),
      buy: (b) => t.service.buy(b),
      sell: (b) => t.service.sell(b),
      job: (id) => t.service.job(id),
    },
    // The Alert leg's own chat when set, else the owner's channels.
    notify: (title, lines) =>
      (legNotifier ?? owner().notifier).notice(title, lines),
    earnings: (date) => nasdaqEarnings(date),
    log,
  });
})();
const strangleTimer = strangle
  ? setInterval(() => void strangle.tick(), 10_000)
  : null;
// The stocks waiting for their side, every second (one price call, only while one waits).
const sideTimer = strangle
  ? setInterval(() => void strangle.watchSides(), 1_000)
  : null;
api.get("/v1/strangle", async () => {
  if (!strangle) throw new RequestError(strangleOff, 409);
  return strangle.status();
});
api.get("/v1/strangle/settings", async () => {
  if (!strangle) throw new RequestError(strangleOff, 409);
  return strangle.settings();
});
api.put("/v1/strangle/settings", async (request) => {
  if (!strangle) throw new RequestError(strangleOff, 409);
  const parsed = parseStrangleSettings(request.body);
  if (!parsed.ok) throw new RequestError(parsed.error);
  return strangle.setSettings(parsed.value);
});

// A stop that sells is reported within this long.
const stopWatchMs = 15_000;
const watchAll = () =>
  Promise.all(
    traders
      .all()
      .map((t) =>
        t.service
          .watchStops()
          .catch((error: unknown) =>
            log(
              `stop watch of ${t.scope} failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
      ),
  );
const stopWatch = setInterval(() => void watchAll(), stopWatchMs);
// Brokers that would let a sell open a short are checked every minute, and
// the account value of brokers without their own history is recorded.
const shorts = new ShortWatch(log);
const equityLog = new EquityLog(store, log);
const failed = (what: string, scope: string) => (error: unknown) =>
  log(
    `${what} of ${scope} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
const recordEquity = () =>
  Promise.all(
    traders
      .all()
      .filter((t) => EquityLog.keeps(t))
      .map((t) => equityLog.record(t).catch(failed("equity record", t.scope))),
  );
const shortWatch = setInterval(() => {
  for (const t of traders.all())
    if (!t.broker.capabilities.closeOnlyOrders)
      shorts.check(t).catch(failed("short check", t.scope));
  void recordEquity();
}, 60_000);

async function stop() {
  clearInterval(stopWatch);
  clearInterval(shortWatch);
  if (botTimer) clearInterval(botTimer);
  if (strangleTimer) clearInterval(strangleTimer);
  if (sideTimer) clearInterval(sideTimer);
  botStore.close();
  strangleStore.close();
  await api.close();
  // A job cut off here is settled by `reconcile` on the next start.
  store.close();
  process.exit(0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

for (const t of traders.all()) {
  const cut = await t.service.reconcile();
  if (cut > 0) log(`settled ${cut} job(s) of ${t.scope} cut off by a restart`);
}
// Stops that sold while the service was down are reported now, and today's
// account value goes on record (not awaited: a slow Gateway must not hold
// the start).
await watchAll();
void recordEquity();
await api.listen({
  host: process.env.TRADER_HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3003),
});
log(
  `trading service listening, ${traders.all().length} trader(s), trading ${process.env.TRADING_ENABLED === "false" ? "switched off" : "on"}, paper accounts`,
);
