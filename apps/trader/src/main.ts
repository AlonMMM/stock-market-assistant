// The trading service (docs/tasks/backend-trading-service.md): holds the
// broker keys, runs orders as jobs and keeps the trade records. Only the
// hosted site talks to it, with TRADER_TOKEN; Claude reaches it through the
// site's connector and never sees a key.
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import { Vault } from "./secrets.js";
import { seedOwner } from "./seed.js";
import { RequestError, type TraderService } from "./service.js";
import { TradeStore } from "./store.js";
import { Traders } from "./traders.js";

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
// The site forwards whom a call is for; without it, the owner's.
const service = (request: FastifyRequest): TraderService => {
  const caller = request.headers["x-trader-user"];
  return traders.forCaller(
    typeof caller === "string" && caller !== "" ? caller : undefined,
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
              `stop watch of ${t.user.id} failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
      ),
  );
const stopWatch = setInterval(() => void watchAll(), stopWatchMs);

async function stop() {
  clearInterval(stopWatch);
  await api.close();
  // A job cut off here is settled by `reconcile` on the next start.
  store.close();
  process.exit(0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

for (const t of traders.all()) {
  const cut = await t.service.reconcile();
  if (cut > 0)
    log(`settled ${cut} job(s) of ${t.user.id} cut off by a restart`);
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
