// The trading service (docs/tasks/backend-trading-service.md): holds the
// broker keys, runs orders as jobs and keeps the trade records. Only the
// hosted site talks to it, with TRADER_TOKEN; Claude reaches it through the
// site's connector and never sees a key.
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Fastify from "fastify";
import { TelegramSender } from "../../../packages/notifications/src/telegram.js";
import {
  AlpacaTrading,
  paperUrl,
} from "../../../packages/trading/src/alpaca-trading.js";
import { TradeEngine } from "../../../packages/trading/src/engine.js";
import {
  NoNotifier,
  TelegramNotifier,
} from "../../../packages/trading/src/notifier.js";
import { RequestError, TraderService } from "./service.js";
import { TradeStore } from "./store.js";

const env = (...names: string[]) =>
  names.map((n) => process.env[n]).find((v) => v) ?? "";

const token = env("TRADER_TOKEN");
if (token.length < 32)
  throw new Error("Set a random TRADER_TOKEN of at least 32 characters");
const key = env("ALPACA_API_KEY", "APCA_API_KEY_ID");
const secret = env("ALPACA_API_SECRET", "APCA_API_SECRET_KEY");
if (!key || !secret)
  throw new Error("Set ALPACA_API_KEY and ALPACA_API_SECRET");
// The live account needs the user's separate authorization and its own switch.
if (process.env.ALPACA_TRADING_LIVE === "true")
  throw new Error("This service trades the paper account only");

const dbPath = process.env.TRADER_DB ?? "data/local/trader.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const store = new TradeStore(dbPath);
// One trader for now; every record already carries the owner.
const userId = process.env.TRADER_USER ?? "owner";
const log = (line: string) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), line }));

const broker = new AlpacaTrading(
  key,
  secret,
  paperUrl,
  process.env.ALPACA_OPTIONS_FEED === "indicative" ? "indicative" : "opra",
);
const telegramToken = process.env.TRADES_TELEGRAM_BOT_TOKEN;
const telegramChat = process.env.TRADES_TELEGRAM_CHAT_ID;
const notifier =
  telegramToken && telegramChat
    ? new TelegramNotifier(new TelegramSender(telegramToken, telegramChat))
    : new NoNotifier();
const engine = new TradeEngine({
  broker,
  notifier,
  posts: store.posts(userId),
  buys: store.buys(userId),
  enabled: process.env.TRADING_ENABLED !== "false",
  log,
});
const service = new TraderService({
  userId,
  store,
  engine,
  broker,
  notifier,
  log,
});

const api = Fastify({ bodyLimit: 16384 });
api.addHook("onRequest", async (request, reply) => {
  if (request.url === "/health") return;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.authorization ?? "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return reply.code(401).send({ error: "Unauthorized" });
});
api.setErrorHandler((error, _request, reply) => {
  if (error instanceof RequestError)
    return reply.code(error.status).send({ error: error.message });
  const text = error instanceof Error ? error.message : String(error);
  log(`request failed: ${text}`);
  return reply.code(502).send({ error: text });
});
const body = (value: unknown) =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

// No account data here: it only says the process is up.
api.get("/health", async () => ({ ok: true }));
api.post("/v1/preview", async (request) => service.preview(body(request.body)));
api.post("/v1/buy", async (request) => service.buy(body(request.body)));
api.post("/v1/sell", async (request) => service.sell(body(request.body)));
api.post("/v1/stop", async (request) => service.stop(body(request.body)));
api.get<{ Params: { id: string } }>("/v1/jobs/:id", async (request) =>
  service.job(request.params.id),
);
api.post<{ Params: { id: string } }>("/v1/jobs/:id/cancel", async (request) =>
  service.cancel({ jobId: request.params.id }),
);
api.post("/v1/cancel", async (request) => service.cancel(body(request.body)));
api.get("/v1/positions", async () => service.status());

async function stop() {
  await api.close();
  // A job cut off here is settled by `reconcile` on the next start.
  store.close();
  process.exit(0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

const cut = await service.reconcile();
if (cut > 0) log(`settled ${cut} job(s) cut off by a restart`);
await api.listen({
  host: process.env.TRADER_HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3003),
});
log(
  `trading service listening, trading ${process.env.TRADING_ENABLED === "false" ? "switched off" : "on"}, paper account`,
);
