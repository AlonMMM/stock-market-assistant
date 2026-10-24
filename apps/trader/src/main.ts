// The trading service (docs/tasks/backend-trading-service.md): holds the
// broker keys, runs orders as jobs and keeps the trade records. Only the
// hosted site talks to it, with TRADER_TOKEN; Claude reaches it through the
// site's connector and never sees a key.
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import { Vault } from "./secrets.js";
import { StoqeyTws } from "../../../packages/trading/src/tws-client.js";
import { ensureOwnerIbkr, seedOwner } from "./seed.js";
import { chooseBotAccount, ensureBotAccount } from "./seed-bot.js";
import { ShortWatch } from "./short-watch.js";
import { RequestError, type TraderService } from "./service.js";
import { TradeStore } from "./store.js";
import { Traders } from "./traders.js";
import botUniverse from "../../../config/bot-universe.json" with { type: "json" };
import { IndiBot } from "./bot.js";
import { nasdaqEarnings } from "./bot-news.js";
import { AlpacaBotMarket } from "./bot-market.js";
import { BotStore } from "./bot-store.js";
import { parseSettings } from "../../../packages/trading/src/bot/settings.js";

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
const vaultKey = env("TRADER_VAULT_KEY");
const traders = new Traders({
  store,
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
api.get("/v1/positions", async (request) => service(request).status());
api.get<{ Querystring: { limit?: string } }>("/v1/decisions", async (request) =>
  service(request).decisions(Number(request.query.limit)),
);

// The Indi bot (docs/tasks/backend-indi-bot.md): on the owner's IBKR paper
// account with BOT_BROKER=ibkr (docs/tasks/backend-bot-ibkr.md), else on its
// own Alpaca paper account once BOT_ALPACA_API_KEY / BOT_ALPACA_API_SECRET are
// set (docs/tasks/backend-bot-account.md), else on the owner's; always through
// the owner's trading service. Off unless BOT_ENABLED=true; a dry run unless
// BOT_MODE=live. Market data comes from the owner's Alpaca keys either way.
const botStore = new BotStore(dbPath);
let botOff = "The bot has no Alpaca keys";
const bot = (() => {
  const key = env("ALPACA_API_KEY", "APCA_API_KEY_ID");
  const secret = env("ALPACA_API_SECRET", "APCA_API_SECRET_KEY");
  if (!key || !secret) return null;
  // A wrong BOT_BROKER stops the service: the bot must never trade the wrong
  // account by accident.
  const choice = chooseBotAccount(store, process.env);
  const owner =
    choice.kind === "default"
      ? () => traders.forCaller(undefined, "alpaca")
      : () => traders.forAccount(choice.account.id);
  if (choice.kind !== "default") {
    try {
      owner(); // its keys or Gateway must be there, or the bot does not run at all
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      botOff = `The bot's account "${choice.account.id}" cannot start: ${why}`;
      log(`${botOff}; the bot is off`);
      return null;
    }
  }
  const account = owner().account;
  if (choice.kind === "ibkr")
    log(
      `the bot trades the owner's IBKR paper account "${account.id}" (BOT_BROKER=ibkr)`,
    );
  else if (choice.kind === "own")
    log(`the bot trades its own account "${account.id}"`);
  else
    log("the bot trades the owner's default account (no BOT_ALPACA_API_KEY)");
  return new IndiBot({
    account: { broker: account.broker, id: account.id },
    store: botStore,
    market: new AlpacaBotMarket(key, secret, "sip"),
    trading: {
      chain: (u, right, from, to) => owner().broker.chain(u, right, from, to),
      quote: (c) => owner().broker.quote(c),
      held: async (c) => {
        const p = await owner()
          .broker.position(c)
          .catch(() => null);
        return p && p.qty > 0 ? p : null;
      },
      equity: () => owner().broker.equity(),
      buy: (b) => owner().service.buy(b),
      sell: (b) => owner().service.sell(b),
      job: (id) => owner().service.job(id),
    },
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
const botTimer = bot ? setInterval(() => void bot.tick(), 10_000) : null;
api.get("/v1/bot", async () => {
  if (!bot) throw new RequestError(botOff, 409);
  return bot.status();
});
// The site sends the user's favorites list before each session.
api.post("/v1/bot/watchlist", async (request) => {
  if (!bot) throw new RequestError(botOff, 409);
  const b = body(request.body);
  if (typeof b.name !== "string" || !Array.isArray(b.tickers))
    throw new RequestError("Need name and tickers");
  return {
    tickers: bot.setWatchlist(
      b.name.slice(0, 40),
      b.tickers.map(String).slice(0, 200),
    ),
  };
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
  return bot.setSettings(parsed.value);
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
// Brokers that would let a sell open a short are checked every minute.
const shorts = new ShortWatch(log);
const shortWatch = setInterval(() => {
  for (const t of traders.all())
    if (!t.broker.capabilities.closeOnlyOrders)
      shorts
        .check(t)
        .catch((error: unknown) =>
          log(
            `short check of ${t.scope} failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
}, 60_000);

async function stop() {
  clearInterval(stopWatch);
  clearInterval(shortWatch);
  if (botTimer) clearInterval(botTimer);
  botStore.close();
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
// Stops that sold while the service was down are reported now.
await watchAll();
await api.listen({
  host: process.env.TRADER_HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3003),
});
log(
  `trading service listening, ${traders.all().length} trader(s), trading ${process.env.TRADING_ENABLED === "false" ? "switched off" : "on"}, paper accounts`,
);
